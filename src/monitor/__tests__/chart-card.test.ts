import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CYAN } from '../../analysis/chart.js'
import type { Candle } from '../../market/geckoterminal.js'

const getMinuteCandles = vi.fn<(chain: string, pool: string) => Promise<Candle[]>>()

vi.mock('../../market/geckoterminal.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../market/geckoterminal.js')>()),
  getMinuteCandles: (chain: string, pool: string) => getMinuteCandles(chain, pool),
}))

const { renderCard } = await import('../chart-card.js')
const { CandleRateLimitError } = await import('../../market/geckoterminal.js')

const START = 1_800_000_000

/** `gapMinutes` is how far apart the candles sit - 1 is a trade every minute. */
function series(count: number, gapMinutes = 1): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    t: START + i * 60 * gapMinutes,
    open: 1 + i * 0.01,
    high: 1 + i * 0.01 + 0.005,
    low: 1 + i * 0.01 - 0.005,
    close: 1 + i * 0.01 + 0.002,
    volume: 100,
  }))
}

const request = {
  symbol: 'TEST',
  chainId: 'solana',
  pairAddress: 'pool',
  rails: [{ value: 1.2, colour: CYAN, label: 'level' }],
}

beforeEach(() => {
  getMinuteCandles.mockReset()
  getMinuteCandles.mockResolvedValue(series(60))
})

describe('renderCard', () => {
  it('draws a card for a dense series', async () => {
    const card = await renderCard(request)
    expect(card).toBeDefined()
  })

  it('refuses a chain with no candle feed without asking for candles', async () => {
    const card = await renderCard({ ...request, chainId: 'nonesuch' })

    expect(card).toBeUndefined()
    expect(getMinuteCandles).not.toHaveBeenCalled()
  })

  it('charts Robinhood Chain, which used to have no feed at all', async () => {
    const card = await renderCard({ ...request, chainId: 'robinhood' })
    expect(card).toBeDefined()
  })

  it('refuses a series too sparse to plot by index', async () => {
    /*
     * The LICKINGCAT case: 150 "one-minute candles" spread over four and a half
     * days. Candles are drawn by index, so that series renders identically to
     * 150 consecutive minutes - a picture that misrepresents time no footer can
     * fix.
     */
    getMinuteCandles.mockResolvedValue(series(150, 44))
    expect(await renderCard(request)).toBeUndefined()

    // A pool trading every couple of minutes is still a fair picture.
    getMinuteCandles.mockResolvedValue(series(150, 2))
    expect(await renderCard(request)).toBeDefined()
  })

  it('refuses a series too short to read a shape off', async () => {
    getMinuteCandles.mockResolvedValue(series(5))
    expect(await renderCard(request)).toBeUndefined()
  })

  it('treats a spent candle budget as no chart, never as a failure', async () => {
    getMinuteCandles.mockRejectedValue(new CandleRateLimitError())
    await expect(renderCard(request)).resolves.toBeUndefined()
  })

  it('does not spend a request when the caller already has the candles', async () => {
    const card = await renderCard({ ...request, candles: series(60) })

    expect(card).toBeDefined()
    expect(getMinuteCandles).not.toHaveBeenCalled()
  })

  it('needs a rail, unless the series itself is the claim', async () => {
    expect(await renderCard({ ...request, rails: [] })).toBeUndefined()
    expect(await renderCard({ ...request, rails: [], seriesIsTheClaim: true })).toBeDefined()
  })

  it('ignores a rail that is not a usable number', async () => {
    const card = await renderCard({
      ...request,
      rails: [{ value: Number.NaN, colour: CYAN, label: 'bad' }],
    })
    expect(card).toBeUndefined()
  })
})
