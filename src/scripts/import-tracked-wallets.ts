/**
 * Imports a curated wallet list into `tracked_wallets`, upserting by
 * (chainId, wallet). This is the only way rows get into that collection -
 * see CLAUDE.md: the earlier auto-discovery approach (Wallet Scout, tagging
 * a wallet's quality from "bought early into a fresh launch") was dropped
 * 2026-08-25 as too weak a signal, in favour of importing a list actually
 * built elsewhere (e.g. strategic-scalp's `tracked_wallets` export).
 *
 * Column headers are matched case-insensitively against COLUMN_MAP below, so
 * the same script reads both a full export (score, win rate, PnL, ...) and a
 * narrower cohort file (wallet, label, cohort, ...) - whatever columns are
 * present are set, the rest stay absent rather than defaulting to zero.
 *
 *   pnpm import:wallets <file.csv> [chainId]
 *
 * chainId defaults to 'solana' (every file seen so far is Solana-only). For
 * an EVM chain (ethereum/bsc/base/robinhood) the wallet column is lowercased
 * on the way in - EVM checksummed casing is not meaningful for lookups, and
 * `/wallet` queries lowercased too (see wallet.ts).
 */
import { readFile } from 'node:fs/promises'
import { connectMongo, closeMongo, getCollections } from '../db/mongo.js'
import type { TrackedWallet } from '../db/models.js'

const [filePath, chainArg] = process.argv.slice(2)
const CHAIN_IDS = ['solana', 'ethereum', 'bsc', 'base', 'robinhood']

if (!filePath) {
  console.error('Usage: pnpm import:wallets <file.csv> [chainId]')
  process.exit(1)
}

const chainId = (chainArg ?? 'solana') as TrackedWallet['chainId']
if (!CHAIN_IDS.includes(chainId)) {
  console.error(`Unknown chainId "${chainId}" - expected one of: ${CHAIN_IDS.join(', ')}`)
  process.exit(1)
}

/** RFC4180-ish: handles quoted fields, embedded commas, and "" as an escaped quote. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((f) => f !== '')) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.some((f) => f !== '')) rows.push(row)
  }

  return rows
}

const parseNumber = (v: string): number | undefined => (v === '' ? undefined : Number(v))
const parseBool = (v: string): boolean => ['t', 'true', '1', 'yes'].includes(v.trim().toLowerCase())
/** "2026-05-25 09:37:09+00" -> a Date node can actually parse. */
function parseTimestamp(v: string): Date | undefined {
  if (v === '') return undefined
  const normalized = v.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/**
 * csv header (lowercased) -> how to apply it to a row-in-progress. A blank
 * cell leaves the key unset entirely rather than setting it to `undefined` -
 * the MongoDB driver serialises an explicit `undefined` property as BSON
 * `null`, which would turn "this column wasn't in the source file" into a
 * stored claim of "measured as null", the same unknown-vs-zero failure every
 * other vendor score in this codebase is careful to avoid.
 */
const COLUMN_MAP: Record<string, (row: Partial<TrackedWallet>, value: string) => void> = {
  wallet: (row, v) => (row.wallet = v.trim()),
  label: (row, v) => v && (row.label = v),
  source: (row, v) => v && (row.source = v),
  cohort: (row, v) => v && (row.cohort = v),
  score: (row, v) => v !== '' && (row.score = parseNumber(v)),
  win_rate_30d: (row, v) => v !== '' && (row.winRate30d = parseNumber(v)),
  avg_hold_min: (row, v) => v !== '' && (row.avgHoldMin = parseNumber(v)),
  avg_pos_sol: (row, v) => v !== '' && (row.avgPosSol = parseNumber(v)),
  active: (row, v) => (row.active = v === '' ? true : parseBool(v)),
  notes: (row, v) => v && (row.notes = v),
  total_trades_30d: (row, v) => v !== '' && (row.totalTrades30d = parseNumber(v)),
  total_pnl_sol_30d: (row, v) => v !== '' && (row.totalPnlSol30d = parseNumber(v)),
  last_active_at: (row, v) => {
    const parsed = parseTimestamp(v)
    if (parsed) row.lastActiveAt = parsed
  },
  early_entry_rate: (row, v) => v !== '' && (row.earlyEntryRate = parseNumber(v)),
  early_entry_win_rate: (row, v) => v !== '' && (row.earlyEntryWinRate = parseNumber(v)),
  early_entry_count: (row, v) => v !== '' && (row.earlyEntryCount = parseNumber(v)),
  favourited: (row, v) => (row.favourited = parseBool(v)),
}

async function main(path: string) {
  const text = await readFile(path, 'utf8')
  const [header, ...dataRows] = parseCsv(text)
  if (!header) {
    console.error('Empty file.')
    process.exit(1)
  }

  const columns = header.map((h) => h.trim().toLowerCase())
  const unknown = columns.filter((c) => !(c in COLUMN_MAP))
  if (unknown.length > 0) {
    console.warn(`Ignoring unrecognised column(s): ${unknown.join(', ')}`)
  }

  const now = new Date()
  const { trackedWallets } = getCollections()
  let imported = 0
  let skipped = 0

  for (const cells of dataRows) {
    const partial: Partial<TrackedWallet> = { active: true }
    columns.forEach((col, i) => COLUMN_MAP[col]?.(partial, cells[i] ?? ''))

    if (!partial.wallet) {
      skipped++
      continue
    }

    const wallet = chainId === 'solana' ? partial.wallet : partial.wallet.toLowerCase()

    await trackedWallets.updateOne(
      { chainId, wallet },
      { $set: { ...partial, wallet, chainId, importedAt: now } },
      { upsert: true },
    )
    imported++
  }

  console.log(`Imported ${imported} wallet(s) into chain "${chainId}" from ${path}.`)
  if (skipped > 0) console.log(`Skipped ${skipped} row(s) with no wallet address.`)
}

await connectMongo()
try {
  await main(filePath)
} finally {
  await closeMongo()
}
