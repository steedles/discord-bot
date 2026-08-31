/**
 * Candlestick chart -> PNG bytes, no dependencies.
 *
 * Ported from money-maker's `strategies/swing/chart.py`, which draws the same
 * card for a Telegram bot. The Python original avoids matplotlib because its
 * collector image is stdlib-only and a plotting library is ~50MB to draw a few
 * hundred rectangles; the reason to keep that shape here is different but points
 * the same way - this is a bundler-free codebase that adds a build toolchain for
 * nothing, and `sharp` or `canvas` is a native module to compile in the
 * Dockerfile for output we can produce with `zlib` and a byte array.
 *
 * So: an RGB framebuffer, a 5x7 bitmap font, and a hand-rolled PNG encoder.
 *
 * The chart answers one question - "where is it now against the level this
 * alert is about" - which is why the rails matter more than the candles. A rail
 * is a labelled horizontal line: the high a token fell from, the level it just
 * crossed, the price a call was made at. An alert with no rail to draw does not
 * get a chart, because then the picture is decoration and decoration next to a
 * number implies a claim nobody measured.
 */
import zlib from 'node:zlib'
import type { Candle } from '../market/geckoterminal.js'

export type RGB = readonly [number, number, number]

/**
 * Mirrored from money-maker's dashboard palette, deliberately - the two surfaces
 * are meant to read as the same product.
 */
export const BG: RGB = [8, 20, 32]
export const PANEL: RGB = [15, 32, 48]
export const LINE: RGB = [29, 53, 73]
export const INK: RGB = [238, 243, 248]
export const MUTED: RGB = [139, 163, 186]
export const UP: RGB = [63, 224, 164]
export const DOWN: RGB = [255, 107, 132]
export const WARN: RGB = [255, 200, 97]
export const CYAN: RGB = [94, 201, 255]
export const VIOLET: RGB = [181, 140, 255]
export const ZONE: RGB = [24, 66, 58]

/**
 * The font. Every glyph is seven pipe-separated rows of five bits.
 *
 * Lowercase renders as uppercase - a chart label does not need a second case,
 * and 26 fewer glyphs is 26 fewer things to get wrong.
 */
const GLYPHS: Record<string, string> = {
  '0': '01110|10001|10011|10101|11001|10001|01110',
  '1': '00100|01100|00100|00100|00100|00100|01110',
  '2': '01110|10001|00001|00010|00100|01000|11111',
  '3': '11111|00010|00100|00010|00001|10001|01110',
  '4': '00010|00110|01010|10010|11111|00010|00010',
  '5': '11111|10000|11110|00001|00001|10001|01110',
  '6': '00110|01000|10000|11110|10001|10001|01110',
  '7': '11111|00001|00010|00100|01000|01000|01000',
  '8': '01110|10001|10001|01110|10001|10001|01110',
  '9': '01110|10001|10001|01111|00001|00010|01100',
  A: '01110|10001|10001|11111|10001|10001|10001',
  B: '11110|10001|10001|11110|10001|10001|11110',
  C: '01110|10001|10000|10000|10000|10001|01110',
  D: '11100|10010|10001|10001|10001|10010|11100',
  E: '11111|10000|10000|11110|10000|10000|11111',
  F: '11111|10000|10000|11110|10000|10000|10000',
  G: '01110|10001|10000|10111|10001|10001|01111',
  H: '10001|10001|10001|11111|10001|10001|10001',
  I: '01110|00100|00100|00100|00100|00100|01110',
  J: '00111|00010|00010|00010|00010|10010|01100',
  K: '10001|10010|10100|11000|10100|10010|10001',
  L: '10000|10000|10000|10000|10000|10000|11111',
  M: '10001|11011|10101|10101|10001|10001|10001',
  N: '10001|11001|10101|10011|10001|10001|10001',
  O: '01110|10001|10001|10001|10001|10001|01110',
  P: '11110|10001|10001|11110|10000|10000|10000',
  Q: '01110|10001|10001|10001|10101|10010|01101',
  R: '11110|10001|10001|11110|10100|10010|10001',
  S: '01111|10000|10000|01110|00001|00001|11110',
  T: '11111|00100|00100|00100|00100|00100|00100',
  U: '10001|10001|10001|10001|10001|10001|01110',
  V: '10001|10001|10001|10001|10001|01010|00100',
  W: '10001|10001|10001|10101|10101|11011|10001',
  X: '10001|10001|01010|00100|01010|10001|10001',
  Y: '10001|10001|01010|00100|00100|00100|00100',
  Z: '11111|00001|00010|00100|01000|10000|11111',
  $: '00100|01111|10100|01110|00101|11110|00100',
  '%': '11001|11010|00010|00100|01000|01011|10011',
  '.': '00000|00000|00000|00000|00000|01100|01100',
  ',': '00000|00000|00000|00000|01100|00100|01000',
  '-': '00000|00000|00000|11111|00000|00000|00000',
  '+': '00000|00100|00100|11111|00100|00100|00000',
  ':': '00000|01100|01100|00000|01100|01100|00000',
  '/': '00001|00010|00010|00100|01000|01000|10000',
  '(': '00010|00100|01000|01000|01000|00100|00010',
  ')': '01000|00100|00010|00010|00010|00100|01000',
  '#': '01010|01010|11111|01010|11111|01010|01010',
  '!': '00100|00100|00100|00100|00100|00000|00100',
  '?': '01110|10001|00001|00010|00100|00000|00100',
  '=': '00000|00000|11111|00000|11111|00000|00000',
  '<': '00010|00100|01000|10000|01000|00100|00010',
  '>': '01000|00100|00010|00001|00010|00100|01000',
  '*': '00000|10101|01110|11111|01110|10101|00000',
  ' ': '00000|00000|00000|00000|00000|00000|00000',
}
const GLYPH_W = 5
const GLYPH_H = 7

/**
 * CRC32, written out rather than taken from `zlib`.
 *
 * `zlib.crc32` only landed in Node 22.2, and this is the one place a runtime
 * bump would turn into a corrupt PNG rather than a crash - a wrong checksum
 * produces bytes that look like a file and fail to decode.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

class Canvas {
  readonly buf: Buffer

  constructor(
    readonly w: number,
    readonly h: number,
    bg: RGB = BG,
  ) {
    this.buf = Buffer.alloc(w * h * 3)
    // Filled through the constructor rather than by a full-canvas rect: one
    // pattern fill against w*h per-pixel writes.
    this.buf.fill(Buffer.from(bg))
  }

  px(x: number, y: number, c: RGB): void {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return
    const o = (y * this.w + x) * 3
    this.buf[o] = c[0]
    this.buf[o + 1] = c[1]
    this.buf[o + 2] = c[2]
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const yStart = Math.max(0, Math.min(y0, y1))
    const yEnd = Math.min(this.h - 1, Math.max(y0, y1))
    const xStart = Math.max(0, Math.min(x0, x1))
    const xEnd = Math.min(this.w - 1, Math.max(x0, x1))
    if (xEnd < xStart || yEnd < yStart) return

    for (let y = yStart; y <= yEnd; y++) {
      for (let x = xStart; x <= xEnd; x++) {
        const o = (y * this.w + x) * 3
        this.buf[o] = c[0]
        this.buf[o + 1] = c[1]
        this.buf[o + 2] = c[2]
      }
    }
  }

  hline(x0: number, x1: number, y: number, c: RGB, dash = 0): void {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      if (dash && Math.floor(x / dash) % 2) continue
      this.px(x, y, c)
    }
  }

  vline(x: number, y0: number, y1: number, c: RGB): void {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.px(x, y, c)
  }

  /** Draws `s` with its top-left at (x, y). Returns the x after the last glyph. */
  text(x: number, y: number, s: string, c: RGB = INK, scale = 1): number {
    let cx = x
    for (const ch of s.toUpperCase()) {
      const rows = GLYPHS[ch]
      if (rows === undefined) {
        cx += (GLYPH_W + 1) * scale
        continue
      }
      rows.split('|').forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          if (row[rx] !== '1') continue
          this.rect(
            cx + rx * scale,
            y + ry * scale,
            cx + rx * scale + scale - 1,
            y + ry * scale + scale - 1,
            c,
          )
        }
      })
      cx += (GLYPH_W + 1) * scale
    }
    return cx
  }

  toPng(): Buffer {
    const stride = this.w * 3
    // One zero filter byte per scanline: filter type 0, "None".
    const raw = Buffer.alloc((stride + 1) * this.h)
    for (let y = 0; y < this.h; y++) {
      raw[y * (stride + 1)] = 0
      this.buf.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }

    const chunk = (tag: string, data: Buffer): Buffer => {
      const length = Buffer.alloc(4)
      length.writeUInt32BE(data.length, 0)
      const tagged = Buffer.concat([Buffer.from(tag, 'ascii'), data])
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(tagged), 0)
      return Buffer.concat([length, tagged, crc])
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0)
    ihdr.writeUInt32BE(this.h, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // colour type 2: truecolour, no alpha
    ihdr[10] = 0
    ihdr[11] = 0
    ihdr[12] = 0

    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }
}

/** Compact USD, matching the axis conventions of the original card. */
function fmtValue(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  if (a >= 1) return `$${v.toFixed(2)}`
  return `$${v.toFixed(6)}`
}

/** A labelled horizontal line. The reason the chart is worth attaching at all. */
export interface Rail {
  value: number
  colour: RGB
  label: string
}

export interface ChartOptions {
  symbol: string
  /**
   * Token supply. Multiplies every price into market cap, because that is the
   * unit a memecoin is discussed in. We do not store supply directly - it comes
   * out of a snapshot as `marketCapUsd / priceUsd`. Absent or <= 0 leaves the
   * axis in price.
   */
  supply?: number
  rails?: Rail[]
  /** Shaded region below this value, with a dashed edge. Drawn under the candles. */
  zoneBelow?: { value: number; label: string }
  headline?: string
  subline?: string
  /**
   * The footer. Says what the picture actually covers.
   *
   * The original hardcoded "{n} x 1h candles". Ours cannot: a candle only exists
   * for a minute that traded, so a hundred and fifty "one-minute candles" can
   * span four days - and because candles are plotted by *index* rather than by
   * time, that series looks exactly like a hundred and fifty consecutive
   * minutes. The caller measures the real span and says so here.
   */
  footer?: string
  bars?: number
  width?: number
  height?: number
}

/**
 * PNG of the last `bars` candles, with rails drawn over them.
 *
 * Two edges are handled rather than thrown: an empty candle list returns a valid
 * PNG that says so, and a perfectly flat series has its range widened so the
 * scale never divides by zero.
 */
export function renderChart(candles: Candle[], options: ChartOptions): Buffer {
  const {
    symbol,
    supply,
    rails = [],
    zoneBelow,
    headline = '',
    subline = '',
    footer,
    bars = 168,
    width = 1000,
    height = 520,
  } = options

  /*
   * A price is positive or it is not a price. Dropping the rest is not
   * defensive tidiness: a non-positive low drags the whole scale negative, and
   * the chart then renders a clean, readable, entirely wrong picture with a
   * "$-106.4K" axis - which is the same failure mode as a wrong pool offset,
   * plausible output rather than an error.
   */
  const usable = candles.filter(
    (k) =>
      [k.open, k.high, k.low, k.close].every((v) => Number.isFinite(v) && v > 0),
  )
  const data = usable.slice(-bars)
  const c = new Canvas(width, height)

  if (data.length === 0) {
    c.text(20, Math.floor(height / 2), 'no candles', MUTED, 2)
    return c.toPng()
  }

  const mult = supply && supply > 0 ? supply : 1
  const L = 16
  const R = width - 118
  const T = 66
  const B = height - 34

  let lo = Math.min(...data.map((k) => k.low * mult))
  let hi = Math.max(...data.map((k) => k.high * mult))
  for (const extra of [...rails.map((r) => r.value), zoneBelow?.value]) {
    if (extra === undefined || !Number.isFinite(extra) || extra <= 0) continue
    lo = Math.min(lo, extra * mult)
    hi = Math.max(hi, extra * mult)
  }
  if (hi <= lo) hi = lo * 1.01 + 1e-12
  const pad = (hi - lo) * 0.06
  lo -= pad
  hi += pad

  const ypx = (v: number): number => Math.round(B - ((v - lo) / (hi - lo)) * (B - T))

  // Header band.
  c.rect(0, 0, width - 1, T - 12, PANEL)
  const afterSymbol = c.text(16, 16, symbol, INK, 3)
  if (headline) c.text(afterSymbol + 18, 18, headline, WARN, 2)
  if (subline) c.text(16, 42, subline, MUTED, 2)

  // Shaded zone, before the candles so they sit on top of it.
  if (zoneBelow && zoneBelow.value > 0) {
    const y = ypx(zoneBelow.value * mult)
    c.rect(L, y, R, B, ZONE)
    c.hline(L, R, y, UP, 3)
    c.text(L + 6, y + 4, zoneBelow.label, UP, 1)
  }

  // Grid, with the value axis in the right-hand gutter.
  for (let i = 0; i < 5; i++) {
    const v = lo + ((hi - lo) * i) / 4
    const y = ypx(v)
    c.hline(L, R, y, LINE)
    c.text(R + 8, y - 3, fmtValue(v), MUTED, 1)
  }

  // Candles.
  const slot = Math.max(2, Math.floor((R - L) / data.length))
  const body = Math.max(1, slot - 2)
  data.forEach((k, i) => {
    const cx = L + i * slot + Math.floor(slot / 2)
    const colour = k.close >= k.open ? UP : DOWN
    c.vline(cx, ypx(k.high * mult), ypx(k.low * mult), colour)
    const y0 = ypx(k.open * mult)
    let y1 = ypx(k.close * mult)
    // A doji would otherwise vanish entirely.
    if (y0 === y1) y1 = y0 + 1
    c.rect(cx - Math.floor(body / 2), Math.min(y0, y1), cx + Math.floor(body / 2), Math.max(y0, y1), colour)
  })

  /*
   * Rail labels sit INSIDE the plot on the left. The right gutter belongs to the
   * value axis, where a rail near a grid line would overprint it. Two rails can
   * still land within a few pixels of each other - a recovery target just under
   * a recorded high is the common case - so each label is nudged clear of the
   * ones already placed.
   */
  const usedLabelY: number[] = []
  for (const rail of rails) {
    if (!Number.isFinite(rail.value) || rail.value <= 0) continue
    const y = ypx(rail.value * mult)
    c.hline(L, R, y, rail.colour, 4)

    let ly = y - 10
    while (usedLabelY.some((u) => Math.abs(ly - u) < GLYPH_H + 3)) ly += GLYPH_H + 3
    usedLabelY.push(ly)
    c.text(L + 6, ly, `${rail.label} ${fmtValue(rail.value * mult)}`, rail.colour, 1)
  }

  // Last price: a solid rule, and an inverted chip in the gutter.
  const last = data[data.length - 1]!.close * mult
  const lastY = ypx(last)
  c.hline(L, R, lastY, INK)
  c.rect(R + 4, lastY - 7, width - 2, lastY + 7, INK)
  c.text(R + 8, lastY - 3, fmtValue(last), BG, 1)

  // The card states its own coverage, so nobody reads a four-day chart as an hour.
  c.text(16, B + 10, footer ?? `${data.length} candles`, MUTED, 1)

  return c.toPng()
}
