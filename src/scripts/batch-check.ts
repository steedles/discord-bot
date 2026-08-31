/**
 * Counts the DexScreener requests one monitor poll actually costs.
 *
 * The batching work is only worth anything if the request count drops, and that
 * is not something a unit test can prove - it depends on how many pools real
 * tokens have and on the upstream honouring a 30-address batch. So this runs the
 * real `fetchSnapshots` against real addresses and counts real requests.
 *
 *   pnpm tsx src/scripts/batch-check.ts <chain> <address> [address...]
 */
import { fetchSnapshots } from '../monitor/providers/dexscreener-source.js'
import type { TokenRef } from '../monitor/providers/types.js'

const [chainId, ...addresses] = process.argv.slice(2)

if (!chainId || addresses.length === 0) {
  console.error('usage: batch-check.ts <chain> <address> [address...]')
  process.exit(1)
}

let requests = 0
const realFetch = globalThis.fetch
globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  if (String(input).includes('api.dexscreener.com')) requests += 1
  return realFetch(input, init)
}) as typeof realFetch

const tokens: TokenRef[] = addresses.map((tokenAddress) => ({
  chainId,
  tokenAddress,
  pairAddress: '',
  symbol: '?',
}))

async function poll(label: string): Promise<void> {
  requests = 0
  const started = Date.now()
  const snapshots = await fetchSnapshots(chainId!, tokens)
  const perToken = (requests / tokens.length).toFixed(2)

  console.log(
    `${label.padEnd(22)} ${requests} requests for ${tokens.length} tokens ` +
      `(${perToken}/token) · ${snapshots.length} snapshots · ${Date.now() - started}ms`,
  )

  for (const s of snapshots.slice(0, 3)) {
    console.log(`    ${s.symbol.padEnd(12)} $${s.priceUsd ?? 'n/a'}  vol24 ${s.volume.h24 ?? 'n/a'}`)
  }
}

/*
 * The limiter unrefs its timer so a queued request can never hold the bot open
 * at shutdown. In the bot something else always keeps the loop alive; in a bare
 * script nothing does, so anything that queues would exit before it is served.
 */
const keepAlive = setInterval(() => {}, 1_000)

try {
  // The first poll has to discover every pool set; the second is the steady
  // state the monitor actually runs in, and is the number that matters.
  await poll('cold (discovery)')
  await poll('warm (batched)')
  await poll('warm (batched)')
} finally {
  clearInterval(keepAlive)
}
