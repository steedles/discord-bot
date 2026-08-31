/**
 * Runs the trend detector over a coin's recent one-minute chart, with no
 * Discord and no MongoDB.
 *
 *   pnpm ta WIF
 *   pnpm ta BONK 3          confirmations = 3
 *
 * Prints the current reading, then replays the last couple of hours bar by bar
 * and lists every turn that would have been announced - the fastest way to see
 * whether a setting is useful or just noisy before inflicting it on a channel.
 */

// Placeholders so config validation passes - this script never talks to Discord.
process.env.DISCORD_TOKEN ||= 'ta-preview'
process.env.DISCORD_CLIENT_ID ||= 'ta-preview'
process.env.LOG_LEVEL ||= 'warn'

const { cadence, detectTurn, DEFAULT_LOOKBACK, MAX_GAP_RATIO, MIN_CANDLES } = await import(
  '../analysis/trend.js'
)
const { CandleRateLimitError, getMinuteCandles, supportsCandles } = await import(
  '../market/geckoterminal.js'
)
const { busiestPair, getPairsForToken } = await import('../market/dexscreener.js')
const { resolveToken } = await import('../market/resolve.js')
const { formatUsdPrice, formatPercent } = await import('../market/format.js')

const [query = 'SOL', rawConfirmations] = process.argv.slice(2)
const confirmations = Number(rawConfirmations) || 2

// Mirrors the worker's defaults so a replay here matches what a channel sees.
const COOLDOWN_MINUTES = 15
const MIN_MOVE_PCT = 1

const { pair } = await resolveToken(query)

if (!supportsCandles(pair.chainId)) {
  console.error(`No minute-candle feed for ${pair.chainId}.`)
  process.exit(1)
}

// The busiest pool, same as /track - the deepest one is often too quiet to read.
const chartPair = busiestPair(await getPairsForToken(pair.baseToken.address), pair.chainId) ?? pair

let candles
try {
  candles = await getMinuteCandles(chartPair.chainId, chartPair.pairAddress)
} catch (err) {
  if (err instanceof CandleRateLimitError) {
    console.error('GeckoTerminal is rate limiting (30 requests/minute, shared). Wait a minute.')
    process.exit(1)
  }
  throw err
}

const spanMinutes =
  candles.length >= 2 ? (candles[candles.length - 1]!.t - candles[0]!.t) / 60 : 0
const density = cadence(candles)

console.log(`\n${pair.baseToken.symbol} · ${pair.chainId} · ${chartPair.dexId}`)
console.log(`pool ${chartPair.pairAddress} (busiest of the token's pools)`)
console.log(
  `${candles.length} closed candles over ${(spanMinutes / 60).toFixed(1)}h` +
    (density ? ` · one every ${density.gapRatio.toFixed(1)} min` : '') +
    `, ${formatUsdPrice(Number(pair.priceUsd))} now`,
)
console.log(`confirmations ${confirmations} of 3 · cooldown ${COOLDOWN_MINUTES}m · min move ${MIN_MOVE_PCT}%\n`)

if (candles.length < MIN_CANDLES) {
  console.log(`Not enough history yet - needs ${MIN_CANDLES} closed candles.`)
  process.exit(0)
}

if (density && density.gapRatio > MAX_GAP_RATIO) {
  console.log(
    `Chart is too sparse to read as a minute trend: one candle every ${density.gapRatio.toFixed(1)} minutes,\n` +
      `and the detector refuses above ${MAX_GAP_RATIO}. Nothing would ever fire for this pool.\n`,
  )
  process.exit(0)
}

const now = detectTurn(candles, { confirmations, lookback: DEFAULT_LOOKBACK })
console.log('=== right now ===')
if (!now) {
  console.log('No turn on the latest closed candle.\n')
} else {
  printSignal(now)
}

console.log('=== replay ===')

let lastDirection: 'up' | 'down' | undefined
let lastAt: number | undefined
let lastPrice: number | undefined
let fired = 0

for (let end = MIN_CANDLES; end <= candles.length; end++) {
  const signal = detectTurn(candles.slice(0, end), { confirmations, lookback: DEFAULT_LOOKBACK })
  if (!signal) continue

  // The worker's three noise rules, applied identically.
  if (signal.direction === lastDirection) continue
  if (lastAt !== undefined && (signal.candleTime - lastAt) / 60 < COOLDOWN_MINUTES) continue
  if (lastPrice !== undefined) {
    const move = (Math.abs(signal.price - lastPrice) / lastPrice) * 100
    if (move < MIN_MOVE_PCT) continue
  }

  lastDirection = signal.direction
  lastAt = signal.candleTime
  lastPrice = signal.price
  fired += 1

  const when = new Date(signal.candleTime * 1000).toISOString().slice(11, 16)
  const signals = signal.agreeing.map((d) => d.key).join('+')
  console.log(
    `${when}  ${signal.direction === 'up' ? '📈 UP  ' : '📉 DOWN'}  ${formatUsdPrice(signal.price)}  ` +
      `${signal.agreeing.length}/3 (${signals})  15m ${formatPercent(signal.change15m)}`,
  )
}

const hours = (spanMinutes / 60).toFixed(1)
console.log(
  fired === 0
    ? `\nNo turns across the last ${hours}h of chart.`
    : `\n${fired} turn${fired === 1 ? '' : 's'} across ${hours}h - about one every ${(spanMinutes / fired / 60).toFixed(1)}h.`,
)

function printSignal(signal: NonNullable<ReturnType<typeof detectTurn>>): void {
  console.log(`${signal.direction === 'up' ? '📈 TURNING UP' : '📉 TURNING DOWN'} at ${formatUsdPrice(signal.price)}`)
  for (const d of signal.agreeing) {
    console.log(`  ✓ ${d.label}${d.barsAgo > 0 ? ` (${d.barsAgo}m ago)` : ''} - ${d.detail}`)
  }
  for (const d of signal.disagreeing) console.log(`  ✗ ${d.label} - ${d.detail}`)
  console.log(
    `  moves: 5m ${formatPercent(signal.change5m)} · 15m ${formatPercent(signal.change15m)} · 1h ${formatPercent(signal.change1h)}\n`,
  )
}
