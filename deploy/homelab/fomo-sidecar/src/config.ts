/**
 * Sidecar configuration. Plain env reading with explicit defaults - this is a
 * ~400 line process with one job, and pulling zod in for it would be more
 * machinery than the thing it configures.
 */

const str = (key: string, fallback?: string): string | undefined => {
  const v = process.env[key]
  return v && v.trim() !== '' ? v.trim() : fallback
}

const num = (key: string, fallback: number): number => {
  const v = Number(process.env[key])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

const bool = (key: string, fallback: boolean): boolean => {
  const v = process.env[key]
  if (v === undefined || v.trim() === '') return fallback
  return !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())
}

export const config = {
  /**
   * MUST be an app route. `https://fomo.family/` is a static marketing page: it
   * opens no websocket and calls no API, so a sidecar pointed there connects to
   * nothing and reports itself perfectly healthy. `/token` redirects to a live
   * token page, which boots the SPA and subscribes to trading_activity.
   */
  appUrl: str('FOMO_APP_URL', 'https://fomo.family/token')!,

  /** Persistent Chrome profile holding the Privy session. A credential - mount it, never bake it. */
  profilePath: str('FOMO_PROFILE_PATH', './profile')!,

  /**
   * Empty uses the bundled Chromium (the Docker image). Locally, 'chrome' uses
   * the installed browser, which is what the session was created with.
   */
  browserChannel: str('FOMO_BROWSER_CHANNEL'),

  headless: bool('FOMO_HEADLESS', true),

  /** Where to POST events. Ignored in dry-run. */
  botUrl: str('FOMO_BOT_URL', 'http://bot:4300')!,
  ingestSecret: str('FOMO_INGEST_SECRET'),

  /** Log events to stdout instead of forwarding them. Phase 1 of the plan. */
  dryRun: bool('FOMO_DRY_RUN', false),

  /** Events are batched briefly so a burst of trades is one request, not ten. */
  batchMs: num('FOMO_BATCH_MS', 1000),
  maxBatch: num('FOMO_MAX_BATCH', 50),

  reconnectMinMs: num('FOMO_RECONNECT_MIN_MS', 5_000),
  reconnectMaxMs: num('FOMO_RECONNECT_MAX_MS', 300_000),

  /** Heartbeat cadence. The bot infers a dead sidecar from these stopping. */
  heartbeatSec: num('FOMO_HEARTBEAT_SEC', 60),

  /** Reload the page if the socket has delivered nothing for this long. */
  idleReloadMin: num('FOMO_IDLE_RELOAD_MIN', 30),

  /**
   * How many recovery attempts to make before giving up and exiting.
   *
   * On 2026-09-14 this process spent **six and a half hours** wedged: the
   * socket reported open, no frames arrived, and every `page.goto` timed out at
   * 60s. It retried that same reload for 389 minutes and would have continued
   * indefinitely, because reloading was the only move it had. A container
   * restart fixed it in seconds.
   *
   * So past this count the process exits non-zero and lets `restart:
   * unless-stopped` build a fresh browser - the same escalation the page-crash
   * handler already documents ("a crashed context is not [recoverable], so let
   * the container restart policy handle that rather than pretending
   * otherwise").
   *
   * Five attempts is **3-8 minutes** of trying from a fresh backoff, and
   * **25-30 minutes** once the backoff has climbed to its 5-minute ceiling -
   * which is where a long wedge finds it. Either way it is bounded, where the
   * old behaviour was not.
   *
   * Counted since the last frame of any kind, so an ordinary quiet market never
   * approaches it: liveness is the ~2000 frames a minute of `prices` and
   * `trending_tokens`, not the traders we follow.
   */
  maxRecoveryAttempts: num('FOMO_MAX_RECOVERY_ATTEMPTS', 5),
} as const

export const WS_HOST = 'prod-api.fomo.family'
export const TRADING_ACTIVITY = 'trading_activity'
