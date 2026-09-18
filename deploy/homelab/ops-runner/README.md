# ops-runner

The homelab half of the dashboard's **Setup** tab. A small Python service that
does the two things a container cannot do for itself: rewrite `.env.homelab`
and restart compose services.

## Why it exists

The setup guide has Ash and Leon inviting the bot and, later, handing over a
Helius key and six Alchemy URLs. Those are environment variables, so applying
them means editing a file on the homelab and recreating the `bot` container -
which used to mean Wayne at a workstation. With this in place, the Setup tab's
**Connect this server** button does it, whoever is around.

## How it works

```
 dashboard (browser) ──POST /api/guilds/:id/setup──▶ bot (container)
                                                       │ holds the values in memory only
                                                       │ writes an audit row to Mongo (key NAMES only)
 ops-runner (host, systemd --user) ◀──GET /api/ops/runner/next, every 10s──┘
     │ claims the job; the values leave the bot's memory
     │ rewrites .env.homelab (backup first, 0600, atomic)
     │ docker compose up -d --no-build bot     (or: restart bot fomo-sidecar)
     │ waits for the healthcheck and Discord ready
     └──POST /api/ops/runner/jobs/:id/result──▶ bot (the NEW process finds the row by id)
```

**The runner pulls.** The bot never opens a connection to the host, holds no
Docker socket and no SSH key. The runner polls loopback with a shared secret
(`OPS_RUNNER_SECRET`, read from `.env.homelab` on every poll so rotating it
needs no restart).

**Nothing the web sends is executed.** A job is one of two types, and its
arguments are checked against fixed lists before anything is touched:

| Job | Arguments | Allowlist |
|---|---|---|
| `apply-env` | key → value | `HELIUS_API_KEY`, `ETHEREUM_RPC_URL`, `ETHEREUM_WS_URL`, `BSC_RPC_URL`, `BSC_WS_URL`, `BASE_RPC_URL`, `BASE_WS_URL` — HTTPS/WSS shape enforced |
| `restart` | services | `bot`, `fomo-sidecar` |

The same lists live in `src/ops/env-keys.ts` and `src/ops/routes.ts` on the
bot side. They are restated here rather than trusted, because this is the
process with write access to the file that also holds `DISCORD_TOKEN`. Adding a
key means adding it in both places.

**Values are never written anywhere but `.env.homelab`.** The bot keeps them in
memory until the runner claims the job; Mongo's `ops_jobs` row records which
keys, by whom, when, and how it went. Log lines (journald) carry key names
only. If the bot restarts between queueing and claiming, the values are gone
and the job is marked failed on the next boot rather than left looking pending.

## Install

On the homelab, once:

```bash
bash ~/discord-bot/deploy/homelab/ops-runner/install.sh
```

It generates `OPS_RUNNER_SECRET` into `.env.homelab` if absent, installs the
unit as `discord-bot-ops-runner.service` under `systemctl --user`, and checks
that lingering is on. If it generated the secret, recreate the bot once so it
starts with it (the script prints the command). `docker-compose.yml` already
passes `OPS_RUNNER_SECRET` through to the bot.

## Operating it

```bash
systemctl --user status discord-bot-ops-runner
journalctl --user -u discord-bot-ops-runner -f
```

A healthy log is quiet - one line at start, then a line per job. The Setup tab
shows **Homelab runner: online** while it has polled in the last minute.

What each job does on the box:

- `apply-env`: `.env.homelab.bak-<stamp>` (last 5 kept, 0600), rewrite in place
  keeping every other line, then `docker compose -p discord-bot --env-file
  ./.env.homelab up -d --no-build bot`. Only `bot` is recreated; `mongo`,
  `cloudflared` and the sidecar are untouched. No `--remove-orphans` - see
  `DEPLOY.md` for why that flag is never used casually on this box.
- `restart`: `docker compose ... restart <services>`, then wait for health.
  Judged against the container's restart count *before* the job, because Docker
  only resets that count on recreate.

Both end by waiting for the `bot` healthcheck and `GET /api/health` reporting
Discord connected, and report the steps back so the dashboard shows exactly
what happened.

## If it goes wrong

- **"rejected the secret"** in the journal: `.env.homelab` was edited after the
  bot started. Recreate the bot (`up -d --no-build bot`).
- **Job stuck at "queued"**: the runner is not polling. `systemctl --user
  status` it; if lingering is off it died with your last logout.
- **Job "claimed but never reported"** (the dashboard says so after 15
  minutes): the runner crashed mid-job. The journal has the traceback; the env
  file backup is beside it if the write is suspect.
- **Bot not healthy after apply**: a bad key does not stop the bot - every one
  of these seven is optional and a wrong Alchemy URL only degrades that chain to
  poll speed. So an unhealthy bot after an apply is almost certainly something
  else; `docker compose logs --tail 60 bot`.
