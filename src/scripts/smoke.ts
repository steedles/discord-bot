/**
 * Checks the market and risk providers without needing Discord or MongoDB.
 *
 *   pnpm smoke              default tokens
 *   pnpm smoke WIF BONK     specific tokens
 *
 * Useful for confirming DexScreener / RugCheck / GoPlus are reachable before
 * blaming the bot.
 */

// Placeholders so config validation passes - this script never talks to Discord.
process.env.DISCORD_TOKEN ||= 'smoke-test'
process.env.DISCORD_CLIENT_ID ||= 'smoke-test'
process.env.LOG_LEVEL ||= 'warn'

const { resolveToken } = await import('../market/resolve.js')
const { checkToken } = await import('../risk/index.js')
const { formatCompactUsd, formatUsdPrice, formatPercent, formatAge } = await import('../market/format.js')
const { pairAgeMinutes } = await import('../market/dexscreener.js')
const { getLatestTokenProfiles } = await import('../market/dexscreener.js')

const queries = process.argv.slice(2)
const targets = queries.length > 0 ? queries : ['SOL', 'WIF', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']

let failures = 0

for (const query of targets) {
  try {
    const { pair } = await resolveToken(query)
    const report = await checkToken(pair.chainId, pair.baseToken.address)

    console.log(
      [
        `\n${pair.baseToken.symbol}  (${pair.chainId} · ${pair.dexId})`,
        `  price     ${formatUsdPrice(pair.priceUsd ? Number(pair.priceUsd) : undefined)}  ${formatPercent(pair.priceChange?.h24)} 24h`,
        `  liquidity ${formatCompactUsd(pair.liquidity?.usd)}   mcap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
        `  age       ${formatAge(pairAgeMinutes(pair))}`,
        `  risk      ${report.level}${report.level === 'unknown' ? '' : ` ${report.score}/100`} via ${report.source}`,
        report.flags.length > 0
          ? `  flags     ${report.flags.map((f) => f.label).slice(0, 4).join(', ')}`
          : '  flags     none',
        report.note ? `  note      ${report.note}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  } catch (err) {
    failures += 1
    console.error(`\n${query}: FAILED - ${String(err)}`)
  }
}

try {
  const profiles = await getLatestTokenProfiles()
  console.log(`\nlaunch feed: ${profiles.length} token profiles available`)
  if (profiles.length === 0) failures += 1
} catch (err) {
  failures += 1
  console.error(`\nlaunch feed: FAILED - ${String(err)}`)
}

console.log(failures === 0 ? '\nAll provider checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
