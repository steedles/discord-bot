/**
 * Renders a chart card to a PNG file, from live candles.
 *
 * The tests prove the encoder emits a decodable PNG. They cannot tell whether
 * the thing is legible - whether rails collide, whether the header crowds the
 * plot, whether 150 one-minute candles are too many to see. That needs an image
 * and a pair of eyes.
 *
 *   pnpm chart-preview <token> [out.png]
 */
import { writeFileSync } from 'node:fs'
import { renderChart, CYAN, UP, VIOLET } from '../analysis/chart.js'
import { cadence } from '../analysis/trend.js'
import { formatAge } from '../market/format.js'
import { busiestPair, getPairsForToken, selectPricePair } from '../market/dexscreener.js'
import { getMinuteCandles, supportsCandles } from '../market/geckoterminal.js'

const [token, outPath = 'chart.png'] = process.argv.slice(2)
if (!token) {
  console.error('usage: chart-preview.ts <tokenAddress> [out.png]')
  process.exit(1)
}

/*
 * A synthetic series, for checking the layout without spending a candle
 * request. The feed is rate limited hard enough that iterating on pixel spacing
 * against live data is not possible - and legibility does not need real prices,
 * only a realistic shape.
 */
if (token === 'demo') {
  /*
   * A synthetic series, for checking the layout without spending a candle
   * request. The feed is rate limited hard enough that iterating on pixel
   * spacing against live data is not possible - and legibility does not need
   * real prices, only a realistic shape: a run up, then a slide off the top.
   */
  const bars = 150
  const demo = []
  let price = 0.0000412
  for (let i = 0; i < bars; i++) {
    const open = price
    // Up for the first sixty percent of the window, down after.
    const drift = i < 90 ? 0.004 : -0.006
    const wobble = Math.sin(i / 3.7) * 0.004 + Math.sin(i / 11.3) * 0.003
    const close = open * (1 + drift + wobble)
    demo.push({
      t: 1_800_000_000 + i * 60,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1_000,
    })
    price = close
  }

  const closes = demo.map((k) => k.close)
  const peak = Math.max(...closes)
  const now = closes[closes.length - 1]!

  writeFileSync(
    outPath,
    renderChart(demo, {
      symbol: 'MANLET',
      supply: 1_000_000_000,
      headline: 'DIP',
      subline: `${(((now - peak) / peak) * 100).toFixed(1)}% off its 2h high`,
      rails: [
        { value: peak, colour: CYAN, label: 'high' },
        { value: now, colour: VIOLET, label: 'alert' },
        { value: now * 1.1, colour: UP, label: 'recovery' },
      ],
      footer: `${demo.length} candles · 2.5h`,
    }),
  )
  console.log(`wrote ${outPath} (demo)`)
  process.exit(0)
}

const pairs = await getPairsForToken(token)
if (pairs.length === 0) {
  console.error('no pairs found for', token)
  process.exit(1)
}

const priced = selectPricePair(pairs)
const chartPair = busiestPair(pairs, priced?.chainId) ?? priced
if (!chartPair) {
  console.error('no usable pair')
  process.exit(1)
}

if (!supportsCandles(chartPair.chainId)) {
  console.error(`${chartPair.chainId} has no candle feed - this token cannot be charted`)
  process.exit(1)
}

const candles = await getMinuteCandles(chartPair.chainId, chartPair.pairAddress)
console.log(
  `${chartPair.baseToken.symbol} on ${chartPair.chainId} · pool ${chartPair.pairAddress} · ${candles.length} candles`,
)

if (candles.length === 0) {
  console.error('no candles returned - the pool may be too quiet')
  process.exit(1)
}

const price = priced?.priceUsd ? Number(priced.priceUsd) : undefined
const marketCap = priced?.marketCap ?? priced?.fdv
// Supply is not stored anywhere; it falls out of the two figures we do have.
const supply = price && marketCap && price > 0 ? marketCap / price : undefined

const closes = candles.map((k) => k.close)
const high = Math.max(...closes)
const last = closes[closes.length - 1]!

const density = cadence(candles, candles.length)
console.log(
  `gap ratio ${density?.gapRatio.toFixed(2) ?? 'n/a'} over ${Math.round(density?.spanMinutes ?? 0)} minutes`,
)

// The rails a real dip alert would draw - no invented stop, which would only
// stretch the axis and squash the price action into a corner.
const png = renderChart(candles, {
  symbol: chartPair.baseToken.symbol,
  supply,
  subline: `${(((last - high) / high) * 100).toFixed(1)}% off its recorded high`,
  rails: [
    { value: high, colour: CYAN, label: 'high' },
    { value: last, colour: VIOLET, label: 'alert' },
    { value: last * 1.1, colour: UP, label: 'recovery' },
  ],
  footer: density
    ? `${density.bars} candles · ${formatAge(density.spanMinutes)}`
    : `${candles.length} candles`,
})

writeFileSync(outPath, png)
console.log(`wrote ${outPath} (${(png.length / 1024).toFixed(1)} KB)`)
