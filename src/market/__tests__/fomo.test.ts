import { describe, expect, it } from 'vitest'
import { fomoSupports, fomoUrl } from '../fomo.js'

describe('fomoUrl', () => {
  it('builds the token page for a Solana mint', () => {
    expect(fomoUrl('solana', '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump')).toBe(
      'https://fomo.family/tokens/solana/9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
    )
  })

  it('builds the token page for a Robinhood-chain contract', () => {
    expect(fomoUrl('robinhood', '0xe934e36a439c94017b64a3fece66af12099abf50')).toBe(
      'https://fomo.family/tokens/robinhood/0xe934e36a439c94017b64a3fece66af12099abf50',
    )
  })

  it("uses fomo's own slug where it differs from ours", () => {
    // BNB Chain is `bsc` here and `bnb` there.
    expect(fomoUrl('bsc', '0x4e8fc9e5a6d2b9c6e7ca8b923661ca4e78087777')).toBe(
      'https://fomo.family/tokens/bnb/0x4e8fc9e5a6d2b9c6e7ca8b923661ca4e78087777',
    )
  })

  it('covers the EVM chains fomo trades', () => {
    expect(fomoUrl('base', '0x9b5e262cf9bb04869ab40b19af91d2dc85761722')).toBe(
      'https://fomo.family/tokens/base/0x9b5e262cf9bb04869ab40b19af91d2dc85761722',
    )
    expect(fomoUrl('ethereum', '0xf280b16ef293d8e534e370794ef26bf312694126')).toBe(
      'https://fomo.family/tokens/ethereum/0xf280b16ef293d8e534e370794ef26bf312694126',
    )
  })

  it('offers nothing for a chain fomo does not trade', () => {
    // A link that 404s is worse than no link on an alert someone is acting on.
    expect(fomoUrl('avalanche', '0xabc')).toBeUndefined()
    expect(fomoUrl('polygon', '0xabc')).toBeUndefined()
    expect(fomoSupports('blast')).toBe(false)
    expect(fomoSupports('arbitrum')).toBe(false)
  })

  it('offers nothing without an address', () => {
    expect(fomoUrl('solana', '')).toBeUndefined()
  })
})
