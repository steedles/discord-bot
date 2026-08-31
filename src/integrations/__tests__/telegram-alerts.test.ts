import { describe, expect, it } from 'vitest'
import { telegramCallText, telegramMonitorText } from '../telegram-alerts.js'
import { snapshot } from '../../monitor/__tests__/fixtures.js'
import type { Trigger } from '../../monitor/detect/types.js'
import type { TokenCall } from '../../db/models.js'

const trigger: Trigger = {
  kind: 'spike',
  headline: '5m volume 8.2x its baseline',
  value: 8.2,
  threshold: 3,
  priority: 'high',
  score: 8.2,
  detail: ['Volume 5m $41K vs $5K baseline'],
}

// PumpSwap so both FOMO and Axiom resolve - Axiom only builds for that dexId (trade-links.ts).
const pumpSwapSnapshot = snapshot({ dexId: 'pumpswap' })

describe('telegramMonitorText', () => {
  it('carries the contract address on its own line, plus FOMO and Axiom', () => {
    const text = telegramMonitorText(trigger, pumpSwapSnapshot)
    const lines = text.split('\n')

    expect(lines).toContain(pumpSwapSnapshot.tokenAddress)
    expect(lines.some((l) => l.startsWith('FOMO: https://'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Axiom: https://'))).toBe(true)
  })

  it('sends no markdown link syntax - this file has no parse_mode set', () => {
    const text = telegramMonitorText(trigger, pumpSwapSnapshot)
    expect(text).not.toContain('[FOMO]')
    expect(text).not.toContain('[Axiom]')
  })

  it('omits Axiom when the pair is not on PumpSwap, same as the Discord embed', () => {
    const text = telegramMonitorText(trigger, snapshot({ dexId: 'raydium' }))
    expect(text).not.toContain('Axiom:')
  })
})

describe('telegramCallText', () => {
  const call: TokenCall = {
    guildId: 'g1',
    channelId: 'c1',
    messageId: 'm1',
    chainId: 'solana',
    tokenAddress: pumpSwapSnapshot.tokenAddress,
    pairAddress: pumpSwapSnapshot.pairAddress,
    symbol: 'TEST',
    priceAtCall: 0.5,
    calledAt: new Date(0),
    alerted: [],
    expiresAt: new Date(0),
  }

  it('carries the contract address and FOMO/Axiom links too', () => {
    const text = telegramCallText(call, pumpSwapSnapshot, trigger)
    const lines = text.split('\n')

    expect(lines).toContain(pumpSwapSnapshot.tokenAddress)
    expect(lines.some((l) => l.startsWith('FOMO: https://'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Axiom: https://'))).toBe(true)
  })
})
