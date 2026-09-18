#!/usr/bin/env python3
"""
ops-runner: does the two things the dashboard's Setup tab cannot do from
inside a container - rewrite .env.homelab and restart compose services.

The direction is the security model. The bot never reaches out here; this
script polls the bot on loopback with a shared secret, claims one job at a
time, does it, and reports back. Nothing the web can send is executed as a
command: a job is a type from ALLOWED_TYPES with arguments that are checked
against fixed allowlists (ENV_RULES, ALLOWED_SERVICES) before anything is
touched. The same rules live in src/ops/env-keys.ts on the bot side; they are
restated here rather than trusted, because this is the process with write
access to the file that holds the Discord token.

Values are never logged. Log lines carry key names and outcomes only.

Runs as a systemd --user service (ops-runner.service); install.sh sets it up.
Python 3 stdlib only, so there is nothing to install on the box.
"""

import datetime as _dt
import json
import os
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

HOME = os.path.expanduser("~")
DEPLOY_DIR = os.environ.get("OPS_DEPLOY_DIR", os.path.join(HOME, "discord-bot", "deploy", "homelab"))
ENV_FILE = os.path.join(DEPLOY_DIR, ".env.homelab")
BOT_URL = os.environ.get("OPS_BOT_URL", "http://127.0.0.1:4300").rstrip("/")
COMPOSE_PROJECT = "discord-bot"
POLL_SEC = int(os.environ.get("OPS_POLL_SEC", "10"))
HEALTH_TIMEOUT_SEC = 240
RESULT_RETRY_SEC = 300
BACKUPS_TO_KEEP = 5

ALLOWED_TYPES = {"apply-env", "restart"}
ALLOWED_SERVICES = {"bot", "fomo-sidecar"}


def _url(scheme):
    def check(v):
        try:
            parts = urlsplit(v)
        except ValueError:
            return "not a URL"
        if parts.scheme != scheme:
            return "must start with %s://" % scheme
        if not parts.hostname:
            return "no hostname"
        if re.search(r"\s", v) or len(v) > 512:
            return "unexpected characters"
        return None

    return check


def _helius(v):
    return None if re.fullmatch(r"[A-Za-z0-9-]{16,128}", v) else "not a Helius key"


# Mirrors ENV_KEYS in src/ops/env-keys.ts. Adding a key means adding it in both.
ENV_RULES = {
    "HELIUS_API_KEY": _helius,
    "ETHEREUM_RPC_URL": _url("https"),
    "ETHEREUM_WS_URL": _url("wss"),
    "BSC_RPC_URL": _url("https"),
    "BSC_WS_URL": _url("wss"),
    "BASE_RPC_URL": _url("https"),
    "BASE_WS_URL": _url("wss"),
}

COMPOSE = ["docker", "compose", "-p", COMPOSE_PROJECT, "--env-file", "./.env.homelab"]


def log(msg, **fields):
    stamp = _dt.datetime.now().strftime("%H:%M:%S")
    extra = " ".join("%s=%s" % (k, v) for k, v in fields.items())
    print("%s %s %s" % (stamp, msg, extra), flush=True)


# --- the env file ----------------------------------------------------------------


def read_secret():
    """OPS_RUNNER_SECRET, read fresh from the env file each poll so a rotation needs no restart."""
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("OPS_RUNNER_SECRET="):
                    return line[len("OPS_RUNNER_SECRET=") :].strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return None


def write_env(values):
    """
    Sets each KEY=value in .env.homelab in place, keeping every other line and
    its order. A key already present is replaced where it is (commented-out
    copies are left alone); a new one is appended. Written via a temp file and
    os.replace so a crash mid-write cannot leave a half file, and the mode is
    forced to 0600 because the file is a credential store.
    """
    with open(ENV_FILE, encoding="utf-8") as fh:
        lines = fh.read().split("\n")

    seen = set()
    out = []
    for line in lines:
        m = re.match(r"^([A-Z0-9_]+)=", line)
        if m and m.group(1) in values and m.group(1) not in seen:
            out.append("%s=%s" % (m.group(1), values[m.group(1)]))
            seen.add(m.group(1))
        else:
            out.append(line)

    # Append the rest. Keep a trailing newline exactly once.
    while out and out[-1] == "":
        out.pop()
    for key in values:
        if key not in seen:
            out.append("%s=%s" % (key, values[key]))
    out.append("")

    backup()
    tmp = ENV_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    os.replace(tmp, ENV_FILE)
    os.chmod(ENV_FILE, stat.S_IRUSR | stat.S_IWUSR)
    return sorted(seen), sorted(set(values) - seen)


def backup():
    """A dated copy beside the file, 0600, oldest pruned past BACKUPS_TO_KEEP - they hold secrets too."""
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = "%s.bak-%s" % (ENV_FILE, stamp)
    with open(ENV_FILE, "rb") as src, open(path, "wb") as dst:
        dst.write(src.read())
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)

    prefix = os.path.basename(ENV_FILE) + ".bak-"
    backups = sorted(f for f in os.listdir(DEPLOY_DIR) if f.startswith(prefix))
    for old in backups[:-BACKUPS_TO_KEEP]:
        os.remove(os.path.join(DEPLOY_DIR, old))


# --- docker ------------------------------------------------------------------------


def run(cmd, timeout=600):
    proc = subprocess.run(cmd, cwd=DEPLOY_DIR, capture_output=True, text=True, timeout=timeout)
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def container_id(service):
    code, out = run(COMPOSE + ["ps", "-q", service])
    return out.split("\n")[0].strip() if code == 0 and out else None


def inspect_state(service):
    cid = container_id(service)
    if not cid:
        return None
    code, out = run(["docker", "inspect", "-f", "{{.State.Running}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", cid])
    if code != 0:
        return None
    running, restarts, health = (out.split() + ["?", "?", "?"])[:3]
    return {"running": running == "true", "restarts": int(restarts) if restarts.isdigit() else -1, "health": health}


def restart_count(service):
    state = inspect_state(service)
    return state["restarts"] if state else 0


def wait_healthy(service, baseline_restarts=0, timeout=HEALTH_TIMEOUT_SEC):
    """
    Waits for the container's own healthcheck. A service without one (the
    sidecar) is judged on running alone, which is all Docker can say.

    RestartCount is Docker's tally of restart-policy restarts and only resets
    when the container is recreated - so "crashed" means it rose above what
    it was before this job, not that it is non-zero.
    """
    deadline = time.time() + timeout
    last = "?"
    while time.time() < deadline:
        state = inspect_state(service)
        if state:
            last = "running=%s restarts=%s health=%s" % (state["running"], state["restarts"], state["health"])
            if state["restarts"] > baseline_restarts:
                return False, "crashed on start (%s)" % last
            if state["running"] and state["health"] in ("healthy", "none"):
                return True, last
        time.sleep(5)
    return False, "not healthy after %ss (%s)" % (timeout, last)


def bot_ready():
    try:
        with urllib.request.urlopen(BOT_URL + "/api/health", timeout=5) as res:
            body = json.load(res)
            return bool(body.get("discord")), body
    except Exception as err:  # noqa: BLE001 - any failure is "not ready"
        return False, str(err)


# --- jobs --------------------------------------------------------------------------


def step(steps, name, ok, detail=None):
    entry = {"name": name, "ok": bool(ok)}
    if detail:
        entry["detail"] = str(detail)[:2000]
    steps.append(entry)
    log("step", name=name, ok=ok, detail=(detail or "")[:200].replace("\n", " "))
    return ok


def do_apply_env(job):
    steps = []
    env = job.get("env") or {}

    # Checked again here, however the bot checked. This is the process that writes.
    clean = {}
    for key, value in env.items():
        rule = ENV_RULES.get(key)
        if rule is None:
            step(steps, "Check %s" % key, False, "not an allowed key")
            continue
        if not isinstance(value, str) or not value.strip():
            step(steps, "Check %s" % key, False, "empty")
            continue
        problem = rule(value.strip())
        if problem:
            step(steps, "Check %s" % key, False, problem)
            continue
        clean[key] = value.strip()

    if not clean or len(clean) != len(env):
        return {"ok": False, "summary": "Refused: a value did not pass the runner's own checks. Nothing was written.", "steps": steps}

    try:
        replaced, added = write_env(clean)
        step(steps, "Write .env.homelab", True, "replaced: %s; added: %s" % (", ".join(replaced) or "-", ", ".join(added) or "-"))
    except Exception as err:  # noqa: BLE001
        step(steps, "Write .env.homelab", False, "%s: %s" % (type(err).__name__, err))
        return {"ok": False, "summary": "Could not write the env file. Nothing restarted.", "steps": steps}

    # Recreate only the bot. No --build (nothing in the image changed), no
    # --remove-orphans (see DEPLOY.md - that flag has deleted another project's
    # containers on this box before). Mongo is a dependency and is left as is.
    code, out = run(COMPOSE + ["up", "-d", "--no-build", "bot"])
    if not step(steps, "Recreate bot", code == 0, out[-800:]):
        return {"ok": False, "summary": "The env file was written but the bot did not recreate. Check the homelab.", "steps": steps}

    ok, detail = wait_healthy("bot")
    step(steps, "Bot healthy", ok, detail)
    if ok:
        ready, body = bot_ready()
        step(steps, "Discord connected", ready, json.dumps(body) if isinstance(body, dict) else body)
        ok = ok and ready

    keys = ", ".join(sorted(clean))
    return {
        "ok": ok,
        "summary": ("Applied %s and the bot is back." % keys) if ok else ("Wrote %s but the bot is not healthy - check `docker compose logs bot`." % keys),
        "steps": steps,
    }


def do_restart(job):
    steps = []
    services = [s for s in (job.get("services") or []) if s in ALLOWED_SERVICES]
    refused = [s for s in (job.get("services") or []) if s not in ALLOWED_SERVICES]
    if refused:
        step(steps, "Check services", False, "refused: %s" % ", ".join(refused))
        return {"ok": False, "summary": "Refused: a service outside the allowlist.", "steps": steps}
    if not services:
        services = sorted(ALLOWED_SERVICES)

    baselines = {s: restart_count(s) for s in services}
    code, out = run(COMPOSE + ["restart"] + services)
    if not step(steps, "Restart %s" % ", ".join(services), code == 0, out[-800:]):
        return {"ok": False, "summary": "docker compose restart failed.", "steps": steps}

    all_ok = True
    for service in services:
        ok, detail = wait_healthy(service, baselines[service])
        step(steps, "%s healthy" % service, ok, detail)
        all_ok = all_ok and ok

    if "bot" in services and all_ok:
        ready, body = bot_ready()
        step(steps, "Discord connected", ready, json.dumps(body) if isinstance(body, dict) else body)
        all_ok = all_ok and ready

    return {
        "ok": all_ok,
        "summary": "Restarted %s." % ", ".join(services) if all_ok else "Restarted, but not everything came back healthy.",
        "steps": steps,
    }


HANDLERS = {"apply-env": do_apply_env, "restart": do_restart}


# --- the loop ----------------------------------------------------------------------


def request(method, path, secret, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BOT_URL + path,
        data=data,
        method=method,
        headers={"authorization": "Bearer " + secret, "content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.load(res)


def report(job_id, secret, result):
    """The job may have restarted the bot; keep trying until it answers."""
    deadline = time.time() + RESULT_RETRY_SEC
    while True:
        try:
            request("POST", "/api/ops/runner/jobs/%s/result" % job_id, secret, result)
            log("reported", job=job_id, ok=result["ok"])
            return
        except Exception as err:  # noqa: BLE001
            if time.time() > deadline:
                log("could not report result", job=job_id, err=str(err)[:200])
                return
            time.sleep(5)


def main():
    log("ops-runner starting", deploy_dir=DEPLOY_DIR, bot=BOT_URL, poll=POLL_SEC)
    warned = False
    while True:
        secret = read_secret()
        if not secret:
            if not warned:
                log("OPS_RUNNER_SECRET is not in .env.homelab - idling until it is")
                warned = True
            time.sleep(POLL_SEC * 3)
            continue
        warned = False

        try:
            job = request("GET", "/api/ops/runner/next", secret).get("job")
        except urllib.error.HTTPError as err:
            if err.code == 401:
                log("bot rejected the secret - does .env.homelab match what the bot started with?")
            elif err.code != 404:
                log("poll failed", status=err.code)
            time.sleep(POLL_SEC)
            continue
        except Exception as err:  # noqa: BLE001 - the bot is simply down; try again
            time.sleep(POLL_SEC)
            continue

        if not job:
            time.sleep(POLL_SEC)
            continue

        job_id = job.get("jobId")
        kind = job.get("type")
        log("claimed", job=job_id, type=kind, keys=",".join(sorted((job.get("env") or {}).keys())), services=",".join(job.get("services") or []))

        handler = HANDLERS.get(kind) if kind in ALLOWED_TYPES else None
        if handler is None:
            result = {"ok": False, "summary": "Refused: unknown job type.", "steps": []}
        else:
            try:
                result = handler(job)
            except Exception as err:  # noqa: BLE001 - report it rather than die holding a claimed job
                log("job crashed", job=job_id, err="%s: %s" % (type(err).__name__, str(err)[:300]))
                result = {"ok": False, "summary": "The runner hit an error: %s" % type(err).__name__, "steps": []}

        # Drop the values before anything else happens with this object.
        job.pop("env", None)
        report(job_id, secret, result)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
