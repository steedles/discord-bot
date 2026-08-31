import { describe, expect, it } from 'vitest'
import { mergeCandles } from '../candle-store.js'
import { fileNameFor, prunable } from '../../log-file.js'
import type { Candle } from '../geckoterminal.js'

const candle = (t: number, close = 1): Candle => ({
  t,
  open: close,
  high: close,
  low: close,
  close,
  volume: 10,
})

describe('mergeCandles', () => {
  it('unions two overlapping fetches by minute', () => {
    const stored = [candle(60), candle(120), candle(180)]
    const fetched = [candle(180), candle(240)]

    expect(mergeCandles(stored, fetched, 100).map((c) => c.t)).toEqual([60, 120, 180, 240])
  })

  it('lets the fresher read win a minute both saw', () => {
    // Same closed minute, different values: the newer fetch is the better read.
    const merged = mergeCandles([candle(60, 1)], [candle(60, 2)], 10)

    expect(merged).toHaveLength(1)
    expect(merged[0]?.close).toBe(2)
  })

  it('keeps the newest, so a long-lived pool cannot lengthen the series', () => {
    /*
     * A pool watched for hours accumulates more history than one fetch returns.
     * Handing a detector a longer series than it has always had would change how
     * its indicators seed, so the cap is not just about memory.
     */
    const stored = Array.from({ length: 300 }, (_, i) => candle(i * 60))
    const merged = mergeCandles(stored, [candle(300 * 60)], 150)

    expect(merged).toHaveLength(150)
    expect(merged[merged.length - 1]?.t).toBe(300 * 60)
  })

  it('returns oldest first, the order indicators read in', () => {
    const merged = mergeCandles([], [candle(180), candle(60), candle(120)], 10)
    expect(merged.map((c) => c.t)).toEqual([60, 120, 180])
  })

  it('copes with either side being empty', () => {
    expect(mergeCandles([], [], 10)).toEqual([])
    expect(mergeCandles([candle(60)], [], 10)).toHaveLength(1)
    expect(mergeCandles([], [candle(60)], 10)).toHaveLength(1)
  })
})

describe('log file rotation', () => {
  it('names a file by UTC date', () => {
    expect(fileNameFor(new Date('2026-08-21T23:30:00Z'))).toBe('bot-2026-08-21.log')
    // An hour later is the next UTC day, whatever the local clock says.
    expect(fileNameFor(new Date('2026-08-22T00:30:00Z'))).toBe('bot-2026-08-22.log')
  })

  it('prunes only files older than the horizon', () => {
    const now = new Date('2026-08-21T12:00:00Z')
    const files = [
      'bot-2026-08-21.log',
      'bot-2026-08-15.log',
      'bot-2026-08-06.log',
      'bot-2026-07-30.log',
    ]

    expect(prunable(files, now, 14)).toEqual(['bot-2026-08-06.log', 'bot-2026-07-30.log'])
  })

  it('ignores anything that is not one of ours', () => {
    // A stray file in the log directory is not this code's to delete.
    const now = new Date('2026-08-21T12:00:00Z')
    expect(prunable(['notes.txt', 'bot.log', 'bot-nope.log', '.keep'], now, 1)).toEqual([])
  })
})
