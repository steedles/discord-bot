#!/usr/bin/env node
/**
 * A token's links, and whether they hold up.
 *
 *   node tools/deep-dive/lib/links.mjs <chain> <address>
 *
 * Pulls the website and socials DexScreener carries for a token, then checks
 * each one: does it resolve, where does it end up after redirects, what is it
 * called, and - the valuable one - does the page mention the contract address we
 * are actually diving.
 *
 * That last check is why this exists. A site that does not name the contract it
 * claims to represent, or names a different one, is the single most useful thing
 * a link check can surface: it separates "real project" from "template with the
 * name swapped in" faster than reading any amount of copy.
 *
 * Prints JSON to stdout, progress to stderr, so it stays pipeable.
 */

const [, , chain, address] = process.argv

if (!chain || !address) {
  console.error('usage: links.mjs <chain> <address>')
  console.error('  chain: solana | ethereum | bsc | base | robinhood | ...')
  process.exit(2)
}

const TIMEOUT_MS = 15_000
const UA = 'Mozilla/5.0 (compatible; deep-dive/1.0)'

const note = (msg) => process.stderr.write(msg + '\n')

/** Single-address token lookup. Never the batched endpoint - it caps at 30 pairs total. */
async function dexPairs() {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${address}`
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`dexscreener ${res.status}`)
  const body = await res.json()
  const pairs = (body.pairs ?? []).filter((p) => !chain || p.chainId === chain || chain === 'any')
  return pairs
}

/**
 * Fetch a URL and describe what came back.
 *
 * Never throws: an unreachable link is a finding, not an error, and one dead
 * social should not abort the whole check.
 */
async function inspect(url) {
  const out = { url, ok: false, status: null, finalUrl: null, title: null, mentionsAddress: null, error: null }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    out.status = res.status
    out.finalUrl = res.url
    out.ok = res.ok

    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('html') || ct.includes('text')) {
      const html = (await res.text()).slice(0, 400_000)
      out.title = (html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '').trim().slice(0, 120) || null
      // Case-insensitive: EVM addresses get rendered in every casing there is.
      // A null here means "page not readable", not "address absent" - the
      // difference matters and is why this is not a boolean by default.
      out.mentionsAddress = html.toLowerCase().includes(address.toLowerCase())
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}

const pairs = await dexPairs().catch((err) => {
  note('dexscreener lookup failed: ' + err.message)
  return []
})

if (pairs.length === 0) {
  console.log(JSON.stringify({ chain, address, error: 'no pairs found on dexscreener', links: [] }, null, 2))
  process.exit(0)
}

// `info` describes a pair's BASE token, so only pairs where our address is the
// base may contribute links.
//
// Without this filter the tool reports the counterparty's project. Asking about
// USDC returned another token's website and docs, confidently labelled as
// USDC's, because USDC is the quote side of almost every pair it appears in.
// A deep dive built on that would be investigating the wrong project entirely.
const isOurs = (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase()
const basePairs = pairs.filter(isOurs)

if (basePairs.length === 0) {
  console.log(
    JSON.stringify(
      {
        chain,
        address,
        error:
          'this address is only ever the QUOTE token in the pairs found - dexscreener carries no project info for it here. Check the chain argument, or that this is a project token rather than a quote asset.',
        pairsSeen: pairs.length,
        links: [],
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

// Union across our own pairs - only some carry `info` at all.
const websites = new Map()
const socials = new Map()
for (const p of basePairs) {
  for (const w of p.info?.websites ?? []) if (w?.url) websites.set(w.url, w.label ?? 'website')
  for (const s of p.info?.socials ?? []) if (s?.url) socials.set(s.url, s.type ?? s.platform ?? 'social')
}

const token = basePairs[0]?.baseToken ?? {}
note(`checking ${websites.size} website(s) and ${socials.size} social(s) for ${token.symbol ?? address}`)

const checks = await Promise.all([
  ...[...websites].map(async ([url, label]) => ({ kind: 'website', label, ...(await inspect(url)) })),
  ...[...socials].map(async ([url, label]) => ({ kind: 'social', label, ...(await inspect(url)) })),
])

const reachable = checks.filter((c) => c.ok)
const confirming = checks.filter((c) => c.mentionsAddress === true)

console.log(
  JSON.stringify(
    {
      chain,
      address,
      token: { symbol: token.symbol ?? null, name: token.name ?? null },
      pairsSeen: pairs.length,
      pairsWhereBase: basePairs.length,
      summary: {
        links: checks.length,
        reachable: reachable.length,
        dead: checks.length - reachable.length,
        // Zero here on a project claiming a real site is worth a hard look.
        mentionThisAddress: confirming.length,
      },
      links: checks,
    },
    null,
    2,
  ),
)
