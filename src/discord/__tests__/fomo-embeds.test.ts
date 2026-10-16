import { describe, expect, it } from 'vitest'
import type { APIEmbed } from 'discord.js'
import { fomoThesisEmbed, fomoTradeEmbed } from '../embeds.js'
import type { FomoActivityEvent } from '../../integrations/fomo/types.js'

const MINT = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mwvnuZcxr'

function event(over: Partial<FomoActivityEvent> = {}): FomoActivityEvent {
  return {
    eventId: 'e1',
    kind: 'BUY',
    traderVerified: false,
    createdAt: new Date('2026-09-27T23:51:00.000Z'),
    receivedAt: new Date('2026-09-27T23:51:02.000Z'),
    ...over,
  }
}

function fields(embed: APIEmbed): string {
  return (embed.fields ?? []).map((field) => `${field.name}: ${field.value}`).join('\n')
}

describe('fomoTradeEmbed', () => {
  it('links the trader and the ticker, and puts market cap on its own line', () => {
    const embed = fomoTradeEmbed(
      event({
        traderName: 'frank',
        traderHandle: 'frankdegods',
        traderAvatarUrl: 'https://cdn.example/frank.jpg',
        ticker: 'NEARKAT',
        usdAmount: 24_900,
        marketCap: 1_200_000,
        chainId: 'solana',
        tokenAddress: MINT,
        tokenImageUrl: 'https://cdn.example/nearkat.png',
      }),
    ).toJSON()

    expect(embed.author?.name).toBe('frank (@frankdegods)')
    expect(embed.author?.url).toBe('https://fomo.family/profile/frankdegods')
    expect(embed.author?.icon_url).toBe('https://cdn.example/frank.jpg')
    expect(embed.thumbnail?.url).toBe('https://cdn.example/nearkat.png')
    expect(embed.description).toContain('[frank](https://fomo.family/profile/frankdegods)')
    expect(embed.description).toContain(`bought **$24.9K** of [$NEARKAT](https://fomo.family/tokens/solana/${MINT})`)
    expect(embed.description).toContain('**MCap**  $1.20M')
    expect(embed.description).not.toContain('Price')

    const body = fields(embed)
    expect(body).toContain('Network: Solana')
    expect(body).toContain(`CA: \`${MINT}\``)
    expect(body).toContain(`[FOMO](https://fomo.family/tokens/solana/${MINT})`)
    expect(body).toContain(`[GMGN](https://gmgn.ai/sol/token/${MINT})`)
    expect(body).not.toContain('axiom.trade')
  })

  it('omits GMGN on a chain GMGN does not cover', () => {
    const embed = fomoTradeEmbed(
      event({
        kind: 'SELL',
        traderName: 'frank',
        traderHandle: 'frankdegods',
        ticker: '부캉이',
        usdAmount: 2_600,
        chainId: 'robinhood',
        tokenAddress: '0xabc',
      }),
    ).toJSON()

    expect(embed.description).toContain('sold **$2.6K** of')
    const body = fields(embed)
    expect(body).toContain('[FOMO](https://fomo.family/tokens/robinhood/0xabc)')
    expect(body).not.toContain('gmgn.ai')
    expect(embed.description).not.toContain('MCap')
  })

  it('ignores an image url that is not http', () => {
    const embed = fomoTradeEmbed(
      event({ tokenImageUrl: 'javascript:alert(1)', traderAvatarUrl: 'data:image/png;base64,aa' }),
    ).toJSON()
    expect(embed.thumbnail).toBeUndefined()
    expect(embed.author?.icon_url).toBeUndefined()
  })
})

describe('fomoThesisEmbed', () => {
  it('links the thesis, the trader and the ticker, and shows holding and pnl', () => {
    const embed = fomoThesisEmbed(
      event({
        kind: 'THESIS',
        traderName: 'Socrates',
        traderHandle: 'socrates',
        ticker: 'slop',
        thesis: 'its time slop runs',
        marketCap: 800_000,
        chainId: 'solana',
        tokenAddress: MINT,
        tokenImageUrl: 'https://cdn.example/slop.png',
        position: { usdValue: 465.8, unrealizedPnlUsd: 136.7, percentageUnrealizedPnl: 41.6 },
      }),
    ).toJSON()

    expect(embed.author?.url).toBe('https://fomo.family/profile/socrates')
    expect(embed.thumbnail?.url).toBe('https://cdn.example/slop.png')
    expect(embed.description).toContain(
      `[Socrates](https://fomo.family/profile/socrates) posted a [thesis](https://fomo.family/tokens/solana/${MINT}) on [$slop](https://fomo.family/tokens/solana/${MINT})`,
    )
    expect(embed.description).toContain('> its time slop runs')
    expect(embed.description).toContain('**MCap**  $800.0K')

    const body = fields(embed)
    expect(body).toContain('Holding: $466')
    expect(body).toContain('PnL: 🟢 +$137 (+41.60%)')
    expect(body).toContain(`Solana · [FOMO](https://fomo.family/tokens/solana/${MINT})`)
    expect(body).not.toContain('Network:')
  })

  it('shows a loss in red and leaves the thesis plain when the token page cannot be built', () => {
    const embed = fomoThesisEmbed(
      event({
        kind: 'THESIS',
        traderName: 'Aurelius',
        thesis: 'autonomous trading',
        position: { unrealizedPnlUsd: -38_900, percentageUnrealizedPnl: -34.5 },
      }),
    ).toJSON()

    expect(embed.description).toContain('posted a thesis on a token')
    expect(embed.description).not.toContain('[thesis](')
    expect(fields(embed)).toContain('PnL: 🔴 -$38.9K (-34.50%)')
  })
})
