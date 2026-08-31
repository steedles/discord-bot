/**
 * Proves the candle store actually skips a request.
 *
 * The claim - "a second chart of the same coin inside the freshness window is
 * free" - is about request counts, which no unit test observes. This seeds the
 * store, then counts real outbound calls: zero is the whole point.
 *
 * Synthetic candles rather than a live fetch, deliberately. What is under test
 * is the decision to skip, not GeckoTerminal, and a test that needs an upstream
 * that rate limits hard is a test that does not run when you need it.
 *
 *   pnpm tsx src/scripts/store-check.ts
 */
process.env.MONGO_DB = `${process.env.MONGO_DB || 'discord_bot'}_storecheck`

const { connectMongo, closeMongo, getCollections } = await import('../db/mongo.js')
const { getMinuteCandles, clearCandleCache } = await import('../market/geckoterminal.js')
const { storeCandles } = await import('../market/candle-store.js')

const CHAIN = 'solana'
const POOL = 'StoreCheckPool1111111111111111111111111111'

let requests = 0
const realFetch = globalThis.fetch
globalThis.fetch = ((i: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  if (String(i).includes('geckoterminal')) requests += 1
  return realFetch(i, init)
}) as typeof realFetch

await connectMongo()
const { candles, candlePools } = getCollections()
await candles.deleteMany({})
await candlePools.deleteMany({})

const keepAlive = setInterval(() => {}, 1_000)

// A dense, closed, one-minute series ending a minute ago.
const nowMin = Math.floor(Date.now() / 60_000) * 60 - 120
const seeded = Array.from({ length: 150 }, (_, i) => ({
  t: nowMin - (149 - i) * 60,
  open: 1 + i * 0.001,
  high: 1 + i * 0.001 + 0.0005,
  low: 1 + i * 0.001 - 0.0005,
  close: 1 + i * 0.001 + 0.0002,
  volume: 100,
}))

await storeCandles(CHAIN, POOL, seeded)
console.log(`seeded ${await candles.countDocuments({})} candles, fetchedAt recorded\n`)

async function call(label: string, maxAgeMs: number, staleFallbackMs?: number): Promise<void> {
  requests = 0
  // Cleared each time, so every case exercises the *store* decision rather than
  // being answered by a memory hit left behind by the previous case.
  clearCandleCache()
  let got: Awaited<ReturnType<typeof getMinuteCandles>> = []
  let note = ''
  try {
    got = await getMinuteCandles(CHAIN, POOL, { maxAgeMs, ...(staleFallbackMs ? { staleFallbackMs } : {}) })
  } catch (err) {
    // Being refused upstream still answers the question this script asks, which
    // is whether the request was attempted at all.
    note = ` (${err instanceof Error ? err.message : String(err)})`
  }
  const verdict = requests === 0 ? 'SKIPPED the fetch' : 'went upstream'
  console.log(
    `  ${label.padEnd(34)} requests=${requests}  candles=${got.length}  -> ${verdict}${note}`,
  )
}

// Fresh enough for a chart: must be served from the store, cold memory cache.
await call('chart window (5 min)', 5 * 60_000)

// Age the recorded fetch past both windows. The chart window now refuses it
// too, which is the guard that stops a stale picture being served forever.
await candlePools.updateOne({ chainId: CHAIN, poolAddress: POOL.toLowerCase() }, {
  $set: { fetchedAt: new Date(Date.now() - 10 * 60_000) },
})
console.log('\nafter ageing the recorded fetch to 10 minutes old:')
await call('chart window (5 min)', 5 * 60_000)

console.log('\nsame, but the caller accepts stale candles when refused:')
await call('chart + 30min stale fallback', 5 * 60_000, 30 * 60_000)

console.log(`\nrows still stored after every call: ${await candles.countDocuments({})}`)

clearInterval(keepAlive)
await closeMongo()
