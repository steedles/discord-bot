/**
 * Runs the rug-signature check (docs/11-RUG-SIGNATURE.md v2 §7 in fresh-start)
 * against the 15 mints the doc benchmarked it on.
 *
 * This is NOT a flag/no-flag accuracy test - v2 §5/§9 is explicit that it
 * cannot be. The check reads *current* top holders, and every coin in this
 * set already rugged, so its cohort has long since sold. All four of the
 * doc's own benchmark runs returned `clean` for exactly that reason - that is
 * expected here too, not a failure. "The first genuine test of whether this
 * flags anything is a live deploy" (§9, open question 5).
 *
 * What this script actually checks, which v2's mechanics changed and which
 * IS still valid against these 15 mints:
 *   - it runs to completion without erroring, on free-tier infrastructure
 *   - it fails loud (`unknown`) rather than quietly scoring `clean` when
 *     holder data can't be resolved (A4 - the correctness bug v1 had)
 *   - wall-clock per mint, against v2's measured 22-75s / median ~57s
 *   - the lamport-tail fingerprint (§3), which - unlike the holder cohort -
 *     reads the creator's own funding transaction, permanent on-chain history
 *     that does not change with time, so it is still a real check
 *
 * The v3 holder-distribution check (`dist=` in the output below) runs
 * alongside the funding graph on every mint here too, and reads the same way:
 * these are old, already-rugged coins, so their *current* distribution has
 * long since scattered as the cohort sold and dumped - mostly `clean` or
 * `unknown` is expected, not evidence the check is broken. See
 * `DISTRIBUTION_CV_FLAG_THRESHOLD`'s own comment in risk/rugSignature.ts for
 * where its threshold actually came from (a live-fetched control set, not
 * these 15).
 *
 *   pnpm tsx src/scripts/rug-check-validate.ts
 */
process.env.MONGO_DB = `${process.env.MONGO_DB || 'discord_bot'}_rugvalidate`

const { connectMongo, closeMongo, getCollections } = await import('../db/mongo.js')
const { checkRugSignature } = await import('../risk/rugSignature.js')
const { config } = await import('../config.js')

interface Case {
  coin: string
  mint: string
  /** null = the original investigation never resolved the funder either. */
  expectTail: boolean | null
  note: string
}

// docs/11-RUG-SIGNATURE.md v2 §7 - the validation set, verbatim. `expectTail`
// is the one column still checkable post-v2 (see file header).
const CASES: Case[] = [
  { coin: 'HOBBES', mint: 'BmzJFt1JJNbvUdUssuPZUp7LCER4FhVVR4ziKHWpump', expectTail: true, note: '5/5, tail' },
  { coin: 'SWOLECAT', mint: 'JBWzQjpJ5BegHuJfUzAAG9a27iXB9m3tvREepccBpump', expectTail: true, note: '5/5, tail' },
  { coin: 'OnlyPump', mint: '7MxzgesvotUpFNU2dU5aqLzYz9nsdeiorpbFe71Cpump', expectTail: true, note: '5/5, tail' },
  { coin: 'PCAT', mint: 'DkdeMtqaaRY3kNHRe1v9gJKeGpyP1PXe5TrrRkWspump', expectTail: true, note: '5/5, tail' },
  { coin: 'まる', mint: 'AuWsWDQxDjqAzhT62z73PWZDhzCzcEuD7iKfytN6pump', expectTail: true, note: '5/5, tail' },
  { coin: 'NALA', mint: '62seDepNrRkMjXwVyF1UACxcQT8WFBeW7QMUxyCLpump', expectTail: true, note: '5/5, tail' },
  { coin: 'ARCHER', mint: 'GBxoYLFsX4ZgVifmYH44gMg15ChPoGPrBnsezo2Epump', expectTail: true, note: '4/5, tail' },
  { coin: 'CATELEEK', mint: '4JEkMTE8yewAAea8AZvSKLW7J6r8WLLVrmhCLWtPpump', expectTail: true, note: 'tail present, extractors unmeasured' },
  { coin: 'CYBERCOIN', mint: 'ErWFD2gFDxxvvo2bVY9PLS6cNqP5EZtRz8PjBp7Epump', expectTail: true, note: 'tail present, extractors unmeasured' },
  { coin: 'pumpito', mint: 'CFTkjggRNdVhEaVFuf1YTdgxG19FFZRa7uM8xZfRpump', expectTail: false, note: 'known false negative - 0/5, no tail' },
  { coin: 'CYBERBULL', mint: '9WdDJ65qfL7c9wv5sf2nKFLD67rzA6w9NwF4Tw83pump', expectTail: false, note: '0/5, no tail' },
  { coin: 'MISO', mint: '9ddBkYDHiqVvxecCG7RM6Tmen9fTeTPPquhLLwTopump', expectTail: false, note: '0/2 resolved, no tail' },
  { coin: 'VII', mint: 'BeDmy2E3dc72eTmdzUpHLqkDMJaEagy9kqEaEHjBpump', expectTail: false, note: '1/5, no tail' },
  { coin: 'ARO', mint: 'FxkG9P5Pn6djkfcwn4LTpCGomuvjPFVnrkFVvHXfpump', expectTail: false, note: '2/5, no tail' },
  { coin: 'Towly', mint: '9T3kuZEmj2oWuiJ4MUQAkEjkUwjHp9WwpbTwAwxJpump', expectTail: null, note: '0/4 resolved, unresolved funder' },
]

if (!config.SOLANA_RPC_URL && !config.HELIUS_API_KEY) {
  console.error('No Solana RPC configured - set SOLANA_RPC_URL or HELIUS_API_KEY and try again.')
  process.exit(1)
}

await connectMongo()
// A clean slate every run - the whole point is re-checking each mint fresh,
// not reading back a previous run's cache.
await getCollections().rugChecks.deleteMany({})

let tailScored = 0
let tailCorrect = 0
let errors = 0
const wallClockMs: number[] = []

for (const { coin, mint, expectTail, note } of CASES) {
  process.stdout.write(`${coin.padEnd(12)} `)
  const started = performance.now()
  try {
    const result = await checkRugSignature(mint)
    const elapsed = performance.now() - started
    wallClockMs.push(elapsed)

    let tailNote = ''
    if (expectTail !== null) {
      tailScored += 1
      const pass = result.tailMatch === expectTail
      if (pass) tailCorrect += 1
      tailNote = ` tail=${result.tailMatch} ${pass ? 'PASS' : 'FAIL'} (expected ${expectTail})`
    }

    const distNote =
      result.distributionCv !== null
        ? ` dist=${result.distributionVerdict}(cv=${result.distributionCv.toFixed(3)}/n=${result.distributionCohort})`
        : ` dist=${result.distributionVerdict}`

    console.log(
      `${result.verdict.toUpperCase().padEnd(7)} ${(elapsed / 1000).toFixed(1)}s  ` +
        `checked=${result.checkedHolders}/${result.totalHolders} cohort=${result.cohortSize} tight=${result.tightCohortSize}` +
        `${tailNote}${distNote}  reason=${result.reason}  (${note})`,
    )
  } catch (err) {
    errors += 1
    console.log(`ERROR  ${err instanceof Error ? err.message : String(err)}`)
  }
}

const median = (arr: number[]) => {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

console.log(`\n${errors} error(s) across ${CASES.length} mints.`)
console.log(`Lamport tail: ${tailCorrect}/${tailScored} matched the doc's documented tail (still valid - see file header).`)
console.log(`Wall clock: median ${(median(wallClockMs) / 1000).toFixed(1)}s (v2 measured 22-75s, median ~57s).`)
console.log(
  `\nVerdicts above are NOT compared to the doc's original flags - v2 explains why in §5/§9.\n` +
    `Mostly 'clean' or 'unknown' here is expected. The real test is a live deploy.`,
)

await closeMongo()
