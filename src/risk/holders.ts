import { log } from '../logger.js'
import { getChain } from '../market/chains.js'
import { fetchJson } from '../market/http.js'
import { fetchGoPlusToken, type GoPlusHolder } from './goplus.js'
import { honeypotSupports } from './honeypot.js'
import { checkToken } from './index.js'

/**
 * Who actually holds the supply.
 *
 * This is deliberately separate from `RiskReport`: none of it is a verdict, it
 * is distribution. "The top five wallets hold 6%" is a fact a reader can weigh
 * themselves, and it never feeds a score - the score stays the vendor's.
 *
 * Both vendors report pool accounts alongside real wallets. A bonding curve
 * holding 31% of supply is normal and says nothing about concentration, so the
 * pools, lockers and burn addresses are stripped out here rather than at each
 * call site.
 */

export interface TopHolder {
  /** Percent of total supply, 0-100. */
  pct: number
  /** The vendor flagged this wallet as insider-linked. Never our judgement. */
  insider?: boolean
}

/** A top holder with its owning wallet - Solana only, RugCheck-sourced. */
export interface OwnedHolder {
  owner: string
  pct: number
  /** RugCheck flagged this wallet as insider-linked (team/creator-connected). */
  insider?: boolean
}

export interface HolderProfile {
  source: 'rugcheck' | 'goplus' | 'none'
  totalHolders?: number
  /** Individual wallets, largest first. Pools, lockers and burns removed. */
  wallets: TopHolder[]
  /** Combined share of the five largest individual wallets. */
  top5Pct?: number
  /** Share still held by the deployer. */
  creatorPct?: number
  /** The deployer's own wallet. Solana only - RugCheck's `creator` field. */
  creatorAddress?: string
  /**
   * The same top holders as `wallets`, but keyed by owning wallet instead of
   * collapsed to `{pct, insider?}` - the rug-signature check (docs/11-RUG-
   * SIGNATURE.md v2 §2 step 3) needs actual addresses to look up who funded
   * each one. Solana/RugCheck only; free - it is the report already fetched
   * for `creatorAddress` above, not a second call.
   */
  ownedWallets?: OwnedHolder[]
  /** Share of the reported wallets the vendor marked insider-linked. */
  insiderPct?: number
  /** How many wallets the vendor actually listed - the basis for the above. */
  sampleSize?: number
  /** Where it was launched, when the vendor recognises the platform. */
  launchpad?: string
  /** Solana: the update authority can still rewrite name, symbol and image. */
  mutableMetadata?: boolean
  /** RugCheck's own call that this token already rugged. */
  rugged?: boolean
  /** Set when there is nothing to report, explaining why. */
  note?: string
}

const EMPTY: HolderProfile = { source: 'none', wallets: [] }

const cache = new Map<string, { at: number; profile: HolderProfile }>()
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 500

/** Distribution for a token, from whichever vendor covers its chain. */
export async function getHolderProfile(chainId: string, address: string): Promise<HolderProfile> {
  const chain = getChain(chainId)
  if (!chain) return { ...EMPTY, note: `No holder data provider for chain "${chainId}".` }

  const key = `${chainId}:${address.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.profile

  const profile =
    chain.kind === 'solana'
      ? await solanaHolders(address)
      : chain.goplusId
        ? await evmHolders(chain.id, chain.goplusId, address)
        : { ...EMPTY, note: `No holder data provider for ${chain.label}.` }

  // A failed lookup must not stick around - the next mention should retry.
  if (profile.source !== 'none') {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { at: Date.now(), profile })
  }

  return profile
}

// --- Solana ---------------------------------------------------------------

interface RugcheckHolder {
  address: string
  owner?: string
  pct?: number
  insider?: boolean
}

interface RugcheckKnownAccount {
  name?: string
  type?: string
}

interface RugcheckReport {
  topHolders?: RugcheckHolder[]
  knownAccounts?: Record<string, RugcheckKnownAccount>
  totalHolders?: number
  creator?: string
  creatorBalance?: number
  token?: { supply?: number }
  tokenMeta?: { mutable?: boolean }
  launchpad?: { name?: string }
  rugged?: boolean
}

/**
 * Accounts that are not somebody's position. `CREATOR` stays in the list -
 * it is reported separately and would otherwise vanish from the picture.
 */
const NOT_A_WALLET = new Set(['AMM', 'LOCKER', 'BURN', 'VAULT'])

/**
 * RugCheck's full report rather than the summary the risk score uses.
 *
 * The summary carries no distribution at all. The full report is large - a
 * megacap can return several hundred KB of insider graph - which is why this is
 * cached and only fetched for surfaces that show holders.
 */
async function solanaHolders(mint: string): Promise<HolderProfile> {
  let data: RugcheckReport
  try {
    data = await fetchJson<RugcheckReport>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      timeoutMs: 15_000,
      retries: 1,
    })
  } catch (err) {
    log.risk.warn({ mint, err: String(err) }, 'rugcheck holder report failed')
    return { ...EMPTY, note: 'RugCheck did not return holder data.' }
  }

  const known = data.knownAccounts ?? {}
  const kind = (h: RugcheckHolder): string | undefined =>
    known[h.address]?.type ?? (h.owner ? known[h.owner]?.type : undefined)

  const realWallets = (data.topHolders ?? [])
    .filter((h) => typeof h.pct === 'number' && h.pct > 0)
    .filter((h) => {
      const type = kind(h)
      return !(type && NOT_A_WALLET.has(type.toUpperCase()))
    })

  const wallets = realWallets
    .map((h) => ({ pct: h.pct!, ...(h.insider ? { insider: true } : {}) }))
    .sort((a, b) => b.pct - a.pct)

  const ownedWallets = realWallets
    .filter((h): h is RugcheckHolder & { owner: string } => Boolean(h.owner))
    .map((h) => ({ owner: h.owner, pct: h.pct!, ...(h.insider ? { insider: true } : {}) }))
    .sort((a, b) => b.pct - a.pct)

  const supply = data.token?.supply
  const creatorPct =
    supply && supply > 0 && typeof data.creatorBalance === 'number'
      ? (data.creatorBalance / supply) * 100
      : undefined

  return {
    source: 'rugcheck',
    wallets,
    ...summarise(wallets),
    ...(data.totalHolders !== undefined ? { totalHolders: data.totalHolders } : {}),
    ...(creatorPct !== undefined ? { creatorPct } : {}),
    ...(data.creator ? { creatorAddress: data.creator } : {}),
    ...(ownedWallets.length > 0 ? { ownedWallets } : {}),
    ...(data.launchpad?.name ? { launchpad: data.launchpad.name } : {}),
    ...(data.tokenMeta?.mutable !== undefined ? { mutableMetadata: data.tokenMeta.mutable } : {}),
    ...(data.rugged !== undefined ? { rugged: data.rugged } : {}),
  }
}

// --- EVM ------------------------------------------------------------------

const BURN_TAGS = /burn|black ?hole|null/i
const LOCK_TAGS = /lock|vault|team ?finance|unicrypt/i

/**
 * How far two vendors' counts may diverge before the smaller one's *sample* is
 * treated as a snapshot of a token that no longer exists in that state.
 *
 * Both a ratio and an absolute gap, because neither alone is safe: 4 holders
 * against 8 is twice as many and means nothing, while 2 against 92 is the same
 * ratio forty-six times over and means GoPlus is describing launch day.
 */
const STALE_COUNT_RATIO = 2
const STALE_COUNT_GAP = 10

/**
 * Whether a vendor's holder *sample* still describes the token.
 *
 * The distribution and the count come from the same GoPlus response, so they
 * are as old as each other. When another vendor counts the holders and gets a
 * wildly different answer, the top-holder list is a picture of an earlier token
 * and printing "92 holders, top 5 hold 2%" beside it would combine one vendor's
 * present with another's past into a sentence neither of them said.
 */
export function sampleIsStale(
  sampleCount: number | undefined,
  trustedCount: number | undefined,
): boolean {
  if (sampleCount === undefined || trustedCount === undefined) return false
  if (!Number.isFinite(sampleCount) || !Number.isFinite(trustedCount)) return false
  if (sampleCount === trustedCount) return false

  const low = Math.min(sampleCount, trustedCount)
  const high = Math.max(sampleCount, trustedCount)

  if (high - low < STALE_COUNT_GAP) return false
  // A zero low is every ratio at once, and is exactly the case this exists for.
  return low <= 0 || high / low >= STALE_COUNT_RATIO
}

/**
 * EVM distribution from GoPlus, with the count checked against honeypot.is.
 *
 * GoPlus is the only EVM vendor here that reports per-wallet shares, so the
 * distribution has to come from it. Its *count* does not have to: on the three
 * chains honeypot.is covers, `checkToken` already holds a number derived from
 * transfer analysis at request time rather than from whenever GoPlus last
 * looked. That call is cached alongside the one `/scan` makes, so asking costs
 * nothing on a surface that was going to ask anyway.
 */
async function evmHolders(
  chainId: string,
  goplusChainId: string,
  address: string,
): Promise<HolderProfile> {
  let token
  try {
    token = await fetchGoPlusToken(goplusChainId, address)
  } catch (err) {
    log.risk.warn({ address, err: String(err) }, 'goplus holder lookup failed')
    return { ...EMPTY, note: 'GoPlus did not return holder data.' }
  }

  if (!token) return { ...EMPTY, note: 'GoPlus has no record for this contract yet.' }

  const isPool = (h: GoPlusHolder): boolean =>
    h.is_contract === 1 ||
    h.is_locked === 1 ||
    BURN_TAGS.test(h.tag ?? '') ||
    LOCK_TAGS.test(h.tag ?? '') ||
    /^0x0{40}$/i.test(h.address) ||
    /dead$/i.test(h.address)

  // GoPlus reports shares as decimals: "0.0768" is 7.68%.
  const wallets = (token.holders ?? [])
    .filter((h) => !isPool(h))
    .map((h) => ({ pct: Number(h.percent) * 100 }))
    .filter((h) => Number.isFinite(h.pct) && h.pct > 0)
    .sort((a, b) => b.pct - a.pct)

  const goplusCount = Number(token.holder_count)
  const creator = Number(token.creator_percent)

  const trustedCount = honeypotSupports(chainId) ? await honeypotHolderCount(chainId, address) : undefined
  const totalHolders = trustedCount ?? (Number.isFinite(goplusCount) ? goplusCount : undefined)

  if (sampleIsStale(Number.isFinite(goplusCount) ? goplusCount : undefined, trustedCount)) {
    log.risk.info(
      { address, chainId, goplusCount, trustedCount },
      'goplus holder sample is out of date - distribution suppressed',
    )
    return {
      source: 'goplus',
      wallets: [],
      ...(totalHolders !== undefined ? { totalHolders } : {}),
      note: `GoPlus last indexed this contract at ${goplusCount.toLocaleString()} holders and honeypot.is counts ${trustedCount!.toLocaleString()}, so its holder breakdown describes an earlier state and is not shown.`,
    }
  }

  return {
    source: 'goplus',
    wallets,
    ...summarise(wallets),
    ...(totalHolders !== undefined ? { totalHolders } : {}),
    ...(Number.isFinite(creator) ? { creatorPct: creator * 100 } : {}),
  }
}

/**
 * honeypot.is's count, via the cached risk report so no extra request is made
 * on a surface that already asked for one. A vendor that did not answer returns
 * undefined and GoPlus's own count stands - the alternative is having no number
 * at all, which is worse than an old one as long as nothing contradicts it.
 */
async function honeypotHolderCount(chainId: string, address: string): Promise<number | undefined> {
  try {
    const report = await checkToken(chainId, address)
    // Only when honeypot.is actually contributed. A report sourced from GoPlus
    // alone carries GoPlus's own count, and comparing that against itself would
    // always agree - a check that can never fail is not a check.
    return report.source.includes('honeypot') ? report.metrics.holderCount : undefined
  } catch (err) {
    log.risk.warn({ address, chainId, err: String(err) }, 'honeypot holder count lookup failed')
    return undefined
  }
}

// --- shared ---------------------------------------------------------------

function summarise(wallets: TopHolder[]): Partial<HolderProfile> {
  if (wallets.length === 0) return {}

  const top5Pct = wallets.slice(0, 5).reduce((sum, w) => sum + w.pct, 0)
  const insiderPct = wallets.filter((w) => w.insider).reduce((sum, w) => sum + w.pct, 0)

  return {
    top5Pct,
    sampleSize: wallets.length,
    ...(insiderPct > 0 ? { insiderPct } : {}),
  }
}
