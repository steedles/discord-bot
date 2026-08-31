/**
 * Renders a Token Brief in the terminal, with no Discord and no MongoDB.
 *
 *   pnpm brief WIF
 *   pnpm brief 0x…  DezXAZ…
 *
 * This is the fastest way to see what the DM will actually say, and to tell
 * whether a thin-looking brief is our wording or a provider that went quiet.
 */

// Placeholders so config validation passes - this script never talks to Discord.
process.env.DISCORD_TOKEN ||= 'brief-preview'
process.env.DISCORD_CLIENT_ID ||= 'brief-preview'
process.env.LOG_LEVEL ||= 'warn'

const { buildBrief } = await import('../analysis/brief.js')
const { resolveToken } = await import('../market/resolve.js')
const { getPairsForToken } = await import('../market/dexscreener.js')
const { assessToken } = await import('../risk/assess.js')
const { getHolderProfile } = await import('../risk/holders.js')
const { truncateAddress } = await import('../market/format.js')
const { poolDepth } = await import('../workers/token-brief.js')

const targets = process.argv.slice(2)
if (targets.length === 0) targets.push('SOL')

let failures = 0

for (const query of targets) {
  try {
    const { pair, verified } = await resolveToken(query)
    const [report, holders, pairs] = await Promise.all([
      assessToken(pair),
      getHolderProfile(pair.chainId, pair.baseToken.address),
      getPairsForToken(pair.baseToken.address),
    ])

    const brief = buildBrief(
      pair,
      report,
      holders,
      poolDepth(pairs.filter((p) => p.chainId === pair.chainId)),
    )

    console.log(`\n${'='.repeat(72)}`)
    console.log(`📋 ${brief.title}`)
    console.log(brief.subtitle)
    if (!verified) {
      console.log(`⚠️  matched by search, not by address - ${truncateAddress(pair.baseToken.address, 8)}`)
    }
    console.log(`${'='.repeat(72)}\n`)

    console.log(`${brief.verdict.emoji} ${brief.verdict.text}\n`)
    console.log(`${plain(brief.summary)}\n`)

    for (const section of brief.sections) {
      console.log(section.title)
      for (const line of section.lines) {
        console.log(`  ${line.label}: ${line.value}${line.meaning ? ` - ${line.meaning}` : ''}`)
      }
      for (const bullet of section.bullets ?? []) console.log(`  ${bullet}`)
      console.log('')
    }

    list('⚠️ What the numbers say', brief.concerns)
    list('✅ In its favour', brief.inFavour)
    list('❓ Nobody checked', brief.notChecked)

    console.log(`sources: ${brief.sources.join(' + ')}`)
  } catch (err) {
    failures += 1
    console.error(`\n${query}: FAILED - ${String(err)}`)
  }
}

function list(title: string, items: string[]): void {
  if (items.length === 0) return
  console.log(title)
  for (const item of items) console.log(`  • ${plain(item)}`)
  console.log('')
}

/** The brief is written for Discord, so strip its markdown for a terminal. */
function plain(text: string): string {
  return text.replace(/\*\*/g, '')
}

process.exit(failures > 0 ? 1 : 0)
