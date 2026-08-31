import { describe, expect, it } from 'vitest'
import { detectWhale, type WhaleConfig } from '../detect/whale.js'
import { whaleSwap } from './fixtures.js'

const config: WhaleConfig = { minUsd: 10_000, highPriorityUsd: 50_000, buysOnly: true }

describe('detectWhale', () => {
  it('fires on a swap above the threshold', () => {
    const trigger = detectWhale(whaleSwap({ amountUsd: 25_000 }), config)

    expect(trigger).toBeDefined()
    expect(trigger!.kind).toBe('whale')
    expect(trigger!.headline).toBe('$25.0K single buy')
  })

  it('ignores a swap below it', () => {
    expect(detectWhale(whaleSwap({ amountUsd: 9_999 }), config)).toBeUndefined()
  })

  it('ignores sells when the channel only wants buys', () => {
    expect(detectWhale(whaleSwap({ side: 'sell', amountUsd: 80_000 }), config)).toBeUndefined()
  })

  it('reports sells when the channel wants them', () => {
    const trigger = detectWhale(whaleSwap({ side: 'sell', amountUsd: 80_000 }), {
      ...config,
      buysOnly: false,
    })

    expect(trigger).toBeDefined()
    expect(trigger!.headline).toContain('sell')
  })

  it('marks the largest swaps high priority', () => {
    expect(detectWhale(whaleSwap({ amountUsd: 60_000 }), config)!.priority).toBe('high')
    expect(detectWhale(whaleSwap({ amountUsd: 20_000 }), config)!.priority).toBe('normal')
  })

  it('says where the dollar figure came from', () => {
    const trigger = detectWhale(whaleSwap(), config)
    expect(trigger!.detail.some((d) => d.includes('last quoted price'))).toBe(true)
  })

  it('ranks by size, so the biggest survives the hourly cap', () => {
    const big = detectWhale(whaleSwap({ amountUsd: 90_000 }), config)!
    const small = detectWhale(whaleSwap({ amountUsd: 12_000 }), config)!

    expect(big.score).toBeGreaterThan(small.score)
  })
})
