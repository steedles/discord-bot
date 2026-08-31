import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DexPair } from '../../market/dexscreener.js'

/**
 * The monitor's request budget lives or dies on these branches.
 *
 * Only the two fetchers are stubbed - `trustedPairs`, `selectPricePair` and the
 * rest stay real, because the thing worth proving is that batching by pool
 * address still hands `snapshotFromPairs` a token's whole pool set. A stub that
 * replaced those too would prove only that the test agrees with itself.
 */
const getPairsForTokens = vi.fn<(addresses: string[]) => Promise<Map<string, DexPair[]>>>()
const getPairsByAddresses = vi.fn<(chainId: string, pools: string[]) => Promise<DexPair[]>>()

vi.mock('../../market/dexscreener.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../market/dexscreener.js')>()),
  getPairsForTokens: (addresses: string[]) => getPairsForTokens(addresses),
  getPairsByAddresses: (chainId: string, pools: string[]) => getPairsByAddresses(chainId, pools),
}))

const { fetchSnapshots, resetPoolSets } = await import('../providers/dexscreener-source.js')

const CHAIN = 'solana'

function pair(token: string, pool: string, priceUsd: string, volumeH24 = 50_000): DexPair {
  return {
    chainId: CHAIN,
    dexId: 'raydium',
    url: `https://dexscreener.com/${CHAIN}/${pool}`,
    pairAddress: pool,
    baseToken: { address: token, name: 'Test', symbol: 'TEST' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
    priceNative: '0.001',
    priceUsd,
    liquidity: { usd: 250_000 },
    volume: { m5: 1_000, h1: 10_000, h6: 30_000, h24: volumeH24 },
    txns: { m5: { buys: 5, sells: 3 }, h1: { buys: 50, sells: 30 }, h6: { buys: 0, sells: 0 }, h24: { buys: 500, sells: 300 } },
    priceChange: { m5: 1, h1: 5, h6: 10, h24: 20 },
    pairCreatedAt: 1_700_000_000_000,
  }
}

const ref = (token: string) => ({
  chainId: CHAIN,
  tokenAddress: token,
  pairAddress: `${token}-pool-a`,
  symbol: 'TEST',
})

beforeEach(() => {
  resetPoolSets()
  getPairsForTokens.mockReset()
  getPairsByAddresses.mockReset()
  getPairsByAddresses.mockResolvedValue([])
  vi.useRealTimers()
})

describe('fetchSnapshots pool-set cache', () => {
  it('discovers an unseen token per token, then reads its pools in bulk', async () => {
    getPairsForTokens.mockResolvedValue(
      new Map([['tokena', [pair('TokenA', 'poolA1', '1.00'), pair('TokenA', 'poolA2', '1.01')]]]),
    )

    const first = await fetchSnapshots(CHAIN, [ref('TokenA')])
    expect(first).toHaveLength(1)
    expect(getPairsForTokens).toHaveBeenCalledTimes(1)
    expect(getPairsByAddresses).not.toHaveBeenCalled()

    // Second poll: the pool set is known, so the token endpoint is not touched.
    getPairsByAddresses.mockResolvedValue([
      pair('TokenA', 'poolA1', '1.10'),
      pair('TokenA', 'poolA2', '1.11'),
    ])

    const second = await fetchSnapshots(CHAIN, [ref('TokenA')])
    expect(getPairsForTokens).toHaveBeenCalledTimes(1)
    // Exact casing: Solana pool addresses are base58 and case-sensitive.
    expect(getPairsByAddresses).toHaveBeenCalledWith(CHAIN, ['poolA1', 'poolA2'])
    expect(second[0]?.priceUsd).toBeCloseTo(1.1)
  })

  it('keeps every pool of a token, so the price consensus still has a quorum', async () => {
    getPairsForTokens.mockResolvedValue(
      new Map([
        [
          'tokena',
          [
            pair('TokenA', 'poolA1', '1.00'),
            pair('TokenA', 'poolA2', '1.02'),
            // A pool quoting 500x - the exact thing selectPricePair drops.
            pair('TokenA', 'poolA3', '500', 90_000),
          ],
        ],
      ]),
    )

    const [snapshot] = await fetchSnapshots(CHAIN, [ref('TokenA')])

    // Volume is summed over the trusted pools only - the liar contributes none.
    expect(snapshot?.priceUsd).toBeLessThan(2)
    expect(snapshot?.volume.h24).toBe(100_000)

    // And the untrusted pool is not carried into the batched path.
    await fetchSnapshots(CHAIN, [ref('TokenA')])
    expect(getPairsByAddresses).toHaveBeenCalledWith(CHAIN, ['poolA1', 'poolA2'])
  })

  it('never rations a token it has no pool set for', async () => {
    const tokens = Array.from({ length: 9 }, (_, i) => `Token${i}`)
    getPairsForTokens.mockImplementation(async (addresses) =>
      new Map(addresses.map((a) => [a.toLowerCase(), [pair(a, `${a}-pool`, '1.00')]])),
    )

    const snapshots = await fetchSnapshots(CHAIN, tokens.map(ref))

    // Nine unknown tokens, all discovered - deferring one means no snapshot at
    // all for a coin that just landed on the watchlist.
    expect(getPairsForTokens).toHaveBeenCalledTimes(1)
    expect(getPairsForTokens.mock.calls[0]?.[0]).toHaveLength(9)
    expect(snapshots).toHaveLength(9)
  })

  it('spreads expired refreshes over several cycles instead of spiking', async () => {
    vi.useFakeTimers()
    const tokens = Array.from({ length: 9 }, (_, i) => `Token${i}`)
    getPairsForTokens.mockImplementation(async (addresses) =>
      new Map(addresses.map((a) => [a.toLowerCase(), [pair(a, `${a}-pool`, '1.00')]])),
    )
    getPairsByAddresses.mockImplementation(async (_c, pools) =>
      pools.map((p) => pair(p.replace('-pool', ''), p, '1.00')),
    )

    await fetchSnapshots(CHAIN, tokens.map(ref))
    expect(getPairsForTokens).toHaveBeenCalledTimes(1)

    // Every set expires together; only four may be refreshed in one cycle.
    vi.advanceTimersByTime(11 * 60_000)
    await fetchSnapshots(CHAIN, tokens.map(ref))

    expect(getPairsForTokens).toHaveBeenCalledTimes(2)
    expect(getPairsForTokens.mock.calls[1]?.[0]).toHaveLength(4)

    // The other five are still served from cache in the same cycle.
    const bulk = getPairsByAddresses.mock.calls.at(-1)?.[1]
    expect(bulk).toHaveLength(5)
  })

  it('forgets a pool set that returns nothing, rather than reporting a dead coin forever', async () => {
    getPairsForTokens.mockResolvedValue(new Map([['tokena', [pair('TokenA', 'poolA1', '1.00')]]]))
    await fetchSnapshots(CHAIN, [ref('TokenA')])

    // The pool is delisted: the bulk read comes back empty.
    getPairsByAddresses.mockResolvedValue([])
    const empty = await fetchSnapshots(CHAIN, [ref('TokenA')])
    expect(empty).toHaveLength(0)

    // Next cycle re-discovers instead of asking for the dead pool again.
    getPairsForTokens.mockResolvedValue(new Map([['tokena', [pair('TokenA', 'poolA9', '2.00')]]]))
    const recovered = await fetchSnapshots(CHAIN, [ref('TokenA')])

    expect(getPairsForTokens).toHaveBeenCalledTimes(2)
    expect(recovered[0]?.priceUsd).toBeCloseTo(2)
  })

  it('attributes a pool to the token it was fetched for, not the pool base token', async () => {
    // A pool where the watched token is the quote side - the batched response
    // still has to land against the token that asked for it.
    const flipped = pair('SomeOtherToken', 'poolA1', '1.00')
    getPairsForTokens.mockResolvedValue(new Map([['tokena', [pair('TokenA', 'poolA1', '1.00')]]]))
    await fetchSnapshots(CHAIN, [ref('TokenA')])

    getPairsByAddresses.mockResolvedValue([flipped])
    const [snapshot] = await fetchSnapshots(CHAIN, [ref('TokenA')])

    expect(snapshot?.tokenAddress).toBe('TokenA')
  })
})
