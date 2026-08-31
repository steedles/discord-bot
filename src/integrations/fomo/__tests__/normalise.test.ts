import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chainIdForNetwork, isKnownNetwork } from '../networks.js'
import { isActivityFrame, isStale, normaliseActivity, parseFrame } from '../normalise.js'
import type { RawFomoActivity } from '../types.js'

/**
 * Fixtures are real `trading_activity` payloads captured from Fomo on
 * 2026-08-31. Only `tokenAddress` and `tokenImageUrl` were sanitised - the
 * capture tool redacts them - so no value here pretends to be a real address.
 * The structure is untouched, which is the point: these tests assert against
 * what Fomo actually sends, not against a shape we imagined.
 */
const FIXTURES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/trading-activity.json'), 'utf8'),
) as Record<'swap_buy' | 'swap_sell' | 'thesis', RawFomoActivity>

const ok = (r: ReturnType<typeof normaliseActivity>) => {
  if (!r.ok) throw new Error('expected normalisation to succeed: ' + r.reason)
  return r.event
}

describe('normaliseActivity', () => {
  it('maps swap_buy to BUY and keeps the money fields', () => {
    const e = ok(normaliseActivity(FIXTURES.swap_buy))
    expect(e.kind).toBe('BUY')
    expect(e.eventId).toBe(FIXTURES.swap_buy.id)
    expect(e.usdAmount).toBe(FIXTURES.swap_buy.usdAmount)
    expect(e.ticker).toBe(FIXTURES.swap_buy.ticker)
    expect(e.traderHandle).toBe(FIXTURES.swap_buy.userHandle)
    expect(e.createdAt.toISOString()).toBe(new Date(FIXTURES.swap_buy.createdAt!).toISOString())
  })

  it('maps swap_sell to SELL', () => {
    const e = ok(normaliseActivity(FIXTURES.swap_sell))
    expect(e.kind).toBe('SELL')
    expect(e.usdAmount).toBeGreaterThan(0)
  })

  it('maps thesis to THESIS and lifts the comment text out of the nested object', () => {
    const e = ok(normaliseActivity(FIXTURES.thesis))
    expect(e.kind).toBe('THESIS')
    expect(e.thesis).toBe(FIXTURES.thesis.comment?.comment)
    expect(e.thesis).toBeTruthy()
    expect(e.position?.usdValue).toBe(FIXTURES.thesis.authorTrade?.usdValue)
  })

  it('does not put thesis-only fields on a trade, or trade-only fields on a thesis', () => {
    expect(ok(normaliseActivity(FIXTURES.swap_buy)).thesis).toBeUndefined()
    expect(ok(normaliseActivity(FIXTURES.swap_buy)).position).toBeUndefined()
  })

  /**
   * The reason dedup keys on `id` and not `tradeId`. A thesis carries the
   * tradeId of the trade it comments on, so deduping on tradeId would silently
   * swallow every thesis attached to a trade already posted.
   */
  it('gives a buy and its own thesis distinct event ids despite a shared tradeId', () => {
    const buy = ok(normaliseActivity(FIXTURES.swap_buy))
    const thesis = ok(normaliseActivity(FIXTURES.thesis))
    expect(thesis.tradeId).toBe(buy.tradeId)
    expect(thesis.eventId).not.toBe(buy.eventId)
  })

  it('treats an unrecognised type as UNKNOWN rather than throwing', () => {
    const e = ok(normaliseActivity({ ...FIXTURES.swap_buy, type: 'swap_something_new' }))
    expect(e.kind).toBe('UNKNOWN')
    expect(e.raw).toBeDefined()
  })

  it('rejects a payload with no id, because it cannot be deduped', () => {
    const r = normaliseActivity({ ...FIXTURES.swap_buy, id: undefined })
    expect(r.ok).toBe(false)
  })

  it('rejects an unparseable createdAt, because the backfill guard needs an age', () => {
    const r = normaliseActivity({ ...FIXTURES.swap_buy, createdAt: 'not-a-date' })
    expect(r.ok).toBe(false)
  })

  it.each([null, undefined, 'string', 42])('rejects a non-object payload (%s)', (input) => {
    expect(normaliseActivity(input).ok).toBe(false)
  })

  it('tolerates every optional field being absent', () => {
    const e = ok(normaliseActivity({ id: 'x', createdAt: '2026-08-31T12:00:00.000Z', type: 'swap_buy' }))
    expect(e.kind).toBe('BUY')
    expect(e.usdAmount).toBeUndefined()
    expect(e.chainId).toBeUndefined()
  })
})

describe('isActivityFrame', () => {
  it('accepts a trading_activity data frame', () => {
    expect(isActivityFrame({ type: 'data', topicType: 'trading_activity', payload: FIXTURES.swap_buy })).toBe(true)
  })

  it('rejects the subscribed acknowledgement, which shares the topic but has no payload', () => {
    expect(isActivityFrame({ type: 'subscribed', topicType: 'trading_activity', activeSubscriptions: 1 })).toBe(false)
  })

  it.each(['trending_tokens', 'prices', 'token_details'])('rejects the %s firehose', (topicType) => {
    expect(isActivityFrame({ type: 'data', topicType, payload: {} })).toBe(false)
  })

  it.each([null, undefined, 'nope', 7])('rejects a non-frame (%s)', (input) => {
    expect(isActivityFrame(input)).toBe(false)
  })
})

describe('parseFrame', () => {
  it('parses a real frame', () => {
    expect(parseFrame('{"type":"challenge"}')?.type).toBe('challenge')
  })

  it.each(['', '{', 'not json', '[1,2,3'])('returns undefined for malformed input (%s)', (input) => {
    expect(parseFrame(input)).toBeUndefined()
  })

  it('returns undefined for valid JSON that is not an object', () => {
    expect(parseFrame('42')).toBeUndefined()
  })
})

describe('chainIdForNetwork', () => {
  it.each([
    [1399811149, 'solana'],
    [1, 'ethereum'],
    [56, 'bsc'],
    [8453, 'base'],
    [4663, 'robinhood'],
  ])('maps %i to %s', (networkId, expected) => {
    expect(chainIdForNetwork(networkId)).toBe(expected)
  })

  /**
   * 143 was seen in trending_tokens and never identified. Guessing it would put
   * real trades on the wrong chain, so it must stay unmapped until confirmed.
   */
  it('leaves the unidentified network 143 unmapped rather than guessing', () => {
    expect(chainIdForNetwork(143)).toBeUndefined()
    expect(isKnownNetwork(143)).toBe(false)
  })

  it('returns undefined for an absent networkId', () => {
    expect(chainIdForNetwork(undefined)).toBeUndefined()
  })
})

describe('isStale', () => {
  const now = new Date('2026-08-31T12:00:00.000Z')
  const at = (iso: string) => ok(normaliseActivity({ id: 'x', type: 'swap_buy', createdAt: iso }, now))

  it('passes a fresh event', () => {
    expect(isStale(at('2026-08-31T11:58:00.000Z'), 10, now)).toBe(false)
  })

  it('drops an event older than the window, so a restart cannot flood the channel', () => {
    expect(isStale(at('2026-08-31T11:00:00.000Z'), 10, now)).toBe(true)
  })

  it('uses Fomo timestamps, not arrival time', () => {
    const e = at('2026-08-31T10:00:00.000Z')
    expect(e.receivedAt).toEqual(now)
    expect(isStale(e, 10, now)).toBe(true)
  })
})
