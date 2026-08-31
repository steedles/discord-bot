import 'dotenv/config'
import { z } from 'zod'

/** "false"/"0"/"no" are falsey; anything else present is truthy. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback
      return !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase())
    })

/** Absent or blank reads as "not set" rather than as an empty string. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined))

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required (see .env.example)'),
  DISCORD_CLIENT_ID: z.string().min(1, 'DISCORD_CLIENT_ID is required (see .env.example)'),
  DISCORD_GUILD_ID: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined)),

  MONGO_URI: z.string().default('mongodb://127.0.0.1:27020'),
  MONGO_DB: z.string().default('discord_bot'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /**
   * Directory for log files that outlive the container.
   *
   * Docker's own logs die with the container they belong to, so a redeploy
   * destroys exactly the diagnostics a redeploy is usually followed by reading.
   * Empty disables file logging; stdout is unaffected either way.
   */
  LOG_DIR: optionalString,
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  PRICE_POLL_SECONDS: z.coerce.number().int().min(15).default(60),
  LAUNCH_POLL_SECONDS: z.coerce.number().int().min(20).default(45),
  /**
   * How often tracked coins are re-read. The candles are one minute wide, so
   * polling faster than that re-reads the same closed bar; the floor is 30s only
   * to allow catching a new bar promptly after it closes.
   */
  TRACK_POLL_SECONDS: z.coerce.number().int().min(30).default(60),

  ENABLE_PUMPPORTAL: boolish(true),
  /**
   * The funding-graph rug check (docs/11-RUG-SIGNATURE.md) - separate from
   * ENABLE_PUMPPORTAL because a deploy can want pump.fun launches without
   * yet trusting this check's RPC cost or its findings. Defaults true (it is
   * meant to run once validated); a deploy still validating it against a
   * real Solana RPC sets this false in its own .env rather than the default
   * changing for everyone.
   */
  ENABLE_RUG_SIGNATURE_CHECK: boolish(true),
  /**
   * Requests the privileged Message Content intent, which Token Brief needs to
   * read token addresses out of other bots' embeds. It must ALSO be enabled in
   * the Discord developer portal or login fails with "disallowed intents".
   */
  ENABLE_MESSAGE_CONTENT: boolish(true),
  PUMPPORTAL_WS: z.string().default('wss://pumpportal.fun/api/data'),

  // --- Volume monitor ---
  MONITOR_ENABLED: boolish(true),
  /**
   * How often the watchlist is re-read. The floor is low because the real
   * constraint is not the interval, it is `tokens x 60 / interval` against the
   * DexScreener budget: 10 tokens every 5s is 120 req/min out of 280, while the
   * 120-token ceiling at 5s would be 1,440 and simply queue behind the limiter -
   * cycles would overrun rather than fail, which is worse because it looks fine.
   * The monitor warns at startup when the configured pair cannot be sustained.
   */
  MONITOR_POLL_SECONDS: z.coerce.number().int().min(5).default(60),
  /**
   * Hard ceiling on the watchlist. The monitor spends one DexScreener request
   * per token per poll - never a batched one, see getPairsForToken - out of a
   * 300/minute budget shared with price alerts and the coin tracker. 120 tokens
   * at 60s uses roughly 40% of it. Raising this without also raising
   * MONITOR_POLL_SECONDS is how the whole bot starts getting 429s - the same
   * trade in reverse, which is why the two are checked together at startup.
   */
  MONITOR_MAX_TOKENS: z.coerce.number().int().min(1).max(280).default(120),
  /**
   * Channel that hears about provider outages. Bot-wide rather than per-guild:
   * a dead RPC is an operator problem, not a server admin's. Empty disables it.
   */
  MONITOR_STATUS_CHANNEL_ID: optionalString,

  /** Enables Solana whale detection. Without it that chain reports unsupported. */
  HELIUS_API_KEY: optionalString,
  /**
   * Solana JSON-RPC endpoints for price streaming. Both default to Helius when
   * an API key is set, and both can be pointed elsewhere - a public endpoint is
   * enough to develop against, and the streamer degrades to polling rather than
   * failing when neither is available.
   */
  SOLANA_RPC_URL: optionalString,
  SOLANA_WS_URL: optionalString,
  /**
   * Budget for the rug-signature check's own RPC calls (docs/11-RUG-SIGNATURE.md),
   * separate from the streamer's usage above. Kept low by default so it is safe
   * to run against a free-tier key - raise it once a paid Helius (or similar)
   * plan is active. At ~75-80 calls per candidate, the default trades speed for
   * never tripping a free tier's limit.
   */
  SOLANA_RPC_CALLS_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  /**
   * Shared secret checked on every webhook delivery. Helius sends it verbatim in
   * the Authorization header. Without it the webhook route refuses to mount -
   * an open endpoint would let anyone forge whale alerts into the channel.
   */
  HELIUS_WEBHOOK_SECRET: optionalString,
  /** Public URL Helius posts to. Defaults to DASHBOARD_URL + /webhooks/helius. */
  HELIUS_WEBHOOK_URL: optionalString,

  /**
   * EVM whale detection reads Swap logs straight from a node. Public endpoints
   * work but rate limit hard; an Alchemy/Infura free tier is the usual answer.
   * A chain without a URL still gets spike and momentum alerts, just no whales.
   */
  ETHEREUM_RPC_URL: optionalString,
  BSC_RPC_URL: optionalString,
  BASE_RPC_URL: optionalString,
  /**
   * Websocket endpoints, which is what makes price streaming possible: the node
   * pushes each `Sync`/`Swap` as it lands instead of us asking every block.
   *
   * A chain without one keeps working at poll speed rather than failing, so
   * these are added per chain as providers are set up. The HTTP URLs above stay
   * required regardless - the whale sweep and the first block read use them.
   */
  ETHEREUM_WS_URL: optionalString,
  BSC_WS_URL: optionalString,
  BASE_WS_URL: optionalString,
  ROBINHOOD_WS_URL: optionalString,
  /**
   * Robinhood Chain publishes a keyless public RPC, so this is the one chain
   * that gets whale detection out of the box. Override it to point at your own
   * node.
   *
   * Blank falls back to the default rather than disabling the chain, because
   * `docker compose` writes an unset variable through as an empty string - so
   * treating blank as "off" would silently turn whale alerts off in production
   * while working fine locally. A failing endpoint degrades on its own: the
   * provider counts failures, reports unhealthy and stops returning swaps.
   */
  ROBINHOOD_RPC_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : 'https://rpc.mainnet.chain.robinhood.com')),

  // --- Private signal intake ---
  /**
   * Outbound hand-off of launch alerts to a personal trading intake, which
   * queues a buy from them. Both the URL and the token must be set or nothing
   * is ever posted - a deployment that does not want this simply leaves them
   * blank, which is the whole opt-in mechanism.
   */
  SIGNAL_INTAKE_URL: optionalString,
  SIGNAL_INTAKE_TOKEN: optionalString,
  /** Sent as `source`, so the intake can tell its producers apart. */
  SIGNAL_INTAKE_SOURCE: z.string().default('fomo-scanner'),
  /**
   * Chains worth posting. The intake accepts anything and refuses it later with
   * a reason, which still spends one of its 60 requests a minute, so the
   * default is the one chain its trader can act on. `*` sends every chain.
   */
  SIGNAL_INTAKE_CHAINS: z
    .string()
    .default('solana')
    .transform((v) =>
      v.trim() === '*'
        ? []
        : v
            .split(',')
            .map((c) => c.trim().toLowerCase())
            .filter(Boolean),
    ),

  // --- Telegram (optional, off by default) ---
  /**
   * Mirrors every high-priority alert (Trigger.priority === 'high' - the same
   * grade that is allowed to ping a role, see mentions.ts) to one Telegram
   * chat, bot-wide rather than per-guild. A personal side-channel like
   * SIGNAL_INTAKE_URL above: both must be set or nothing is ever sent, which
   * is the whole opt-in mechanism.
   */
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  // --- Fomo.family activity monitor (optional, off by default) ---
  /**
   * Real-time buys, sells and theses from traders the Fomo account follows.
   *
   * Ingested by a separate `fomo-sidecar` container which drives a real browser
   * and forwards raw payloads here - Playwright cannot run in this image
   * (node:alpine, musl) and a browser crash must not be able to take the bot
   * with it. Off unless both this and FOMO_INGEST_SECRET are set.
   *
   * Fomo has no public API. See docs/FOMO-INTEGRATION-PLAN.md, including what
   * it says about their terms of service.
   */
  FOMO_ENABLED: boolish(false),
  /** Shared secret the sidecar presents on POST /api/fomo/events. */
  FOMO_INGEST_SECRET: optionalString,
  /**
   * Events older than this are discarded on arrival, before dedup sees them.
   *
   * A restart resubscribes and Fomo may replay recent activity. Posting an
   * hour-old trade as though it just happened is worse than missing it - the
   * same call whale-buys makes about its log sweep.
   */
  FOMO_MAX_EVENT_AGE_MIN: z.coerce.number().int().min(1).max(1440).default(10),
  /**
   * Silence, in minutes, before the feed is treated as broken.
   *
   * This is the most important number here. Fomo is an undocumented private
   * API: when they rename a field or drop a topic we do not get an error, we
   * get nothing at all. A feed that quietly died four hours ago is worse than
   * no feed, so silence has to be loud.
   */
  FOMO_STALE_MIN: z.coerce.number().int().min(5).max(1440).default(60),
  /**
   * Where to send "the Fomo feed is down and reconnecting did not fix it".
   *
   * Falls back to TELEGRAM_CHAT_ID. Accepts a numeric chat id or an @channel
   * name. This is deliberately a side-channel rather than a Discord post: the
   * thing being reported is that the pipeline into Discord has stopped working.
   */
  FOMO_ALERT_TELEGRAM_CHAT: optionalString,
  /** Ignore trades below this USD value. 0 posts everything. */
  FOMO_MIN_USD: z.coerce.number().min(0).default(0),

  // --- Holdings page (owner-only dashboard tab) ---
  /**
   * The two wallets the Holdings page reads on-chain balances for directly -
   * it never tracks or infers a wallet, only ever this one pair someone typed
   * into config. Blank means that half of the page has nothing to show, same
   * "blank is opt-out" rule as every other optional integration here.
   */
  HOLDINGS_SOLANA_WALLET: optionalString,
  /**
   * One address, checked across HOLDINGS_EVM_CHAINS - the same 0x address is
   * valid on every EVM chain, it is simply a different account on each.
   */
  HOLDINGS_EVM_WALLET: optionalString,
  /**
   * Chains checked for HOLDINGS_EVM_WALLET, comma separated. Each needs a free
   * Blockscout instance with a token-balances endpoint - confirmed live for
   * ethereum, base and robinhood (see market/blockscout.ts); bsc has none (its
   * Etherscan-family equivalent is a paid-plan-only endpoint), so it is left
   * out of the default rather than silently returning nothing for it.
   */
  HOLDINGS_EVM_CHAINS: z
    .string()
    .default('ethereum,base,robinhood')
    .transform((v) =>
      v
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    ),

  // --- Dashboard ---
  DASHBOARD_ENABLED: boolish(true),
  DASHBOARD_PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  DASHBOARD_HOST: z.string().default('0.0.0.0'),
  /** Public base URL, used to build the OAuth redirect and the /feature link. */
  DASHBOARD_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim().replace(/\/$/, '') : '')),
  /** Discord OAuth2 client secret. Required only when the dashboard is on. */
  DISCORD_CLIENT_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined)),
  /** HMAC key for session cookies. Required only when the dashboard is on. */
  SESSION_SECRET: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined)),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /**
   * Email + password logins for the dashboard, as `email:scrypt$salt$hash`
   * entries separated by commas or newlines. Generate one with
   * `pnpm dashboard:hash <password>`.
   *
   * Empty disables the password form entirely - the route then rejects every
   * attempt rather than admitting anyone, the same way the dashboard refuses to
   * start without its OAuth secrets.
   */
  DASHBOARD_USERS: z.string().default(''),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  console.error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`)
  process.exit(1)
}

export const config = parsed.data
export type Config = typeof config

/**
 * The dashboard needs three extra secrets. Rather than making them globally
 * required, it fails closed: if any are missing the dashboard refuses to start
 * and the bot carries on without it. An unauthenticated config panel would be
 * far worse than no config panel.
 */
export function dashboardReadiness(): { ready: boolean; missing: string[] } {
  const missing: string[] = []
  if (!config.DISCORD_CLIENT_SECRET) missing.push('DISCORD_CLIENT_SECRET')
  if (!config.SESSION_SECRET) missing.push('SESSION_SECRET')
  if (!config.DASHBOARD_URL) missing.push('DASHBOARD_URL')
  return { ready: missing.length === 0, missing }
}
