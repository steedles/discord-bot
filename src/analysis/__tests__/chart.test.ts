import { describe, expect, it } from 'vitest'
import zlib from 'node:zlib'
import { renderChart, CYAN, UP, type RGB } from '../chart.js'
import type { Candle } from '../../market/geckoterminal.js'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    t: 1_800_000_000 + i * 60,
    open: i === 0 ? close : closes[i - 1]!,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volume: 1_000,
  }))
}

/**
 * Decodes the PNG back to a pixel reader.
 *
 * Asserting on bytes is the only way to know the encoder is right - a wrong CRC
 * or a missed filter byte produces a file that looks plausible and fails to
 * open, which no length check would catch.
 */
function decode(png: Buffer): { w: number; h: number; at: (x: number, y: number) => RGB } {
  expect(png.subarray(0, 8)).toEqual(PNG_MAGIC)

  let offset = 8
  let w = 0
  let h = 0
  const idat: Buffer[] = []

  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const tag = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)

    if (tag === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      expect(data[8]).toBe(8) // bit depth
      expect(data[9]).toBe(2) // truecolour
    }
    if (tag === 'IDAT') idat.push(data)
    offset += 12 + length
  }

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * 3
  expect(raw.length).toBe((stride + 1) * h)

  return {
    w,
    h,
    at: (x, y) => {
      const o = y * (stride + 1) + 1 + x * 3
      return [raw[o]!, raw[o + 1]!, raw[o + 2]!] as const
    },
  }
}

describe('renderChart', () => {
  it('emits a decodable PNG at the requested size', () => {
    const png = renderChart(candles([1, 2, 3, 4, 5]), { symbol: 'TEST', width: 400, height: 240 })
    const img = decode(png)

    expect(img.w).toBe(400)
    expect(img.h).toBe(240)
  })

  it('every scanline carries its filter byte', () => {
    // A missed filter byte shifts every row by one pixel and still decodes.
    const png = renderChart(candles([1, 2, 3]), { symbol: 'X', width: 200, height: 120 })
    const raw = (() => {
      let offset = 8
      const idat: Buffer[] = []
      while (offset < png.length) {
        const length = png.readUInt32BE(offset)
        const tag = png.subarray(offset + 4, offset + 8).toString('ascii')
        if (tag === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
        offset += 12 + length
      }
      return zlib.inflateSync(Buffer.concat(idat))
    })()

    for (let y = 0; y < 120; y++) expect(raw[y * (200 * 3 + 1)]).toBe(0)
  })

  it('returns a valid image rather than throwing on no candles', () => {
    const png = renderChart([], { symbol: 'EMPTY' })
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC)
    expect(decode(png).w).toBe(1000)
  })

  it('survives a perfectly flat series', () => {
    // Without widening the range the scale divides by zero and every y is NaN.
    const flat = candles([5, 5, 5, 5]).map((k) => ({ ...k, high: 5, low: 5, open: 5, close: 5 }))
    const png = renderChart(flat, { symbol: 'FLAT', width: 300, height: 200 })
    expect(decode(png).w).toBe(300)
  })

  it('draws a rail in its own colour', () => {
    const withRail = renderChart(candles([10, 11, 12]), {
      symbol: 'R',
      width: 400,
      height: 240,
      rails: [{ value: 11, colour: CYAN, label: 'level' }],
    })
    const img = decode(withRail)

    let found = false
    for (let y = 0; y < img.h && !found; y++) {
      for (let x = 20; x < 200; x++) {
        const [r, g, b] = img.at(x, y)
        if (r === CYAN[0] && g === CYAN[1] && b === CYAN[2]) {
          found = true
          break
        }
      }
    }
    expect(found).toBe(true)
  })

  it('shades the zone below a level', () => {
    const png = renderChart(candles([10, 11, 12]), {
      symbol: 'Z',
      width: 400,
      height: 240,
      zoneBelow: { value: 11, label: 'below' },
    })
    const img = decode(png)

    // The dashed edge of the zone is drawn in UP.
    let found = false
    for (let y = 0; y < img.h && !found; y++) {
      for (let x = 20; x < 300; x++) {
        const [r, g, b] = img.at(x, y)
        if (r === UP[0] && g === UP[1] && b === UP[2]) {
          found = true
          break
        }
      }
    }
    expect(found).toBe(true)
  })

  it('scales the axis by supply so it reads as market cap', () => {
    // Same candles, different axis: only the labels change, so the two images
    // must differ without either failing to encode.
    const price = renderChart(candles([1, 2, 3]), { symbol: 'S', width: 400, height: 240 })
    const mcap = renderChart(candles([1, 2, 3]), {
      symbol: 'S',
      width: 400,
      height: 240,
      supply: 1_000_000,
    })

    expect(price.equals(mcap)).toBe(false)
    expect(decode(mcap).w).toBe(400)
  })

  it('drops non-positive candles instead of rendering a negative axis', () => {
    // A negative low drags the whole scale below zero and produces a clean,
    // readable, entirely wrong picture with a "$-106.4K" axis.
    const poisoned = [
      ...candles([10, 11, 12]),
      { t: 1, open: -5, high: -4, low: -6, close: -5, volume: 0 },
      { t: 2, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { t: 3, open: Number.NaN, high: 1, low: 1, close: 1, volume: 0 },
    ]

    const clean = renderChart(candles([10, 11, 12]), { symbol: 'G', width: 400, height: 240 })
    const guarded = renderChart(poisoned, { symbol: 'G', width: 400, height: 240 })

    expect(guarded.equals(clean)).toBe(true)
  })

  it('says so rather than throwing when nothing survives the guard', () => {
    const png = renderChart([{ t: 1, open: -1, high: -1, low: -1, close: -1, volume: 0 }], {
      symbol: 'BAD',
    })
    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC)
  })

  it('is deterministic, so a divergence is never the renderer', () => {
    const a = renderChart(candles([1, 2, 3]), { symbol: 'D', width: 300, height: 200 })
    const b = renderChart(candles([1, 2, 3]), { symbol: 'D', width: 300, height: 200 })
    expect(a.equals(b)).toBe(true)
  })
})
