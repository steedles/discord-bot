#!/usr/bin/env node
/**
 * What can be learned about an X (Twitter) account without an API key.
 *
 *   node tools/deep-dive/lib/x-profile.mjs <handle-or-url> [<handle-or-url> ...] [--expect TICKER]
 *
 * X serves Open Graph metadata to unauthenticated requests, which is less than
 * an API gives and more than nothing:
 *
 *   AVAILABLE      account exists, display name, bio, canonical handle after
 *                  any rename/redirect
 *   NOT AVAILABLE  follower count, join date, the timeline, engagement -
 *                  none of it is in the served HTML, so no amount of parsing
 *                  will produce it
 *
 * The discriminator, measured 2026-09-03: a handle that does not exist still
 * returns HTTP 200, but with NO og:title. Status code alone tells you nothing;
 * the presence of og:title is the signal.
 *
 * The highest-value check here is not the bio, it is existence. A coin linking
 * to an X account that does not exist, or whose bio is about something else
 * entirely, has told you more than any sentiment reading would.
 */

const args = process.argv.slice(2)
const expectIdx = args.indexOf('--expect')
const expect = expectIdx >= 0 ? args[expectIdx + 1] : null
const targets = args.filter((a, i) => a !== '--expect' && i !== expectIdx + 1)

if (targets.length === 0) {
  console.error('usage: x-profile.mjs <handle-or-url> [...] [--expect TICKER]')
  process.exit(2)
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'

/** Accepts @name, name, twitter.com/name, x.com/name?s=20 - all the shapes a link comes in. */
function handleOf(input) {
  const s = String(input).trim()
  const m = s.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i)
  if (m) return m[1]
  return s.replace(/^@/, '').replace(/\/.*$/, '')
}

const meta = (html, key) => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i')
  return html.match(re)?.[1] ?? null
}

async function check(input) {
  const handle = handleOf(input)
  const url = `https://x.com/${handle}`
  const out = {
    input,
    handle,
    url,
    exists: null,
    displayName: null,
    bio: null,
    canonicalUrl: null,
    renamedTo: null,
    bioMentionsExpected: null,
    error: null,
  }

  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) })
    const html = await res.text()

    const title = meta(html, 'og:title')
    // A missing handle returns 200 with no og:title, so this - not res.ok - is
    // the existence test.
    out.exists = Boolean(title)
    if (!out.exists) return out

    out.displayName = title.replace(/\s*\(@[^)]*\)\s*on X$/i, '').trim() || null
    out.bio = meta(html, 'description')
    out.canonicalUrl = meta(html, 'og:url')

    // A canonical handle different from the one linked means the account was
    // renamed. Worth knowing: recycled accounts are how a "two-year-old
    // project" gets an account older than its contract.
    const canonicalHandle = out.canonicalUrl ? handleOf(out.canonicalUrl) : null
    if (canonicalHandle && canonicalHandle.toLowerCase() !== handle.toLowerCase()) {
      out.renamedTo = canonicalHandle
    }

    if (expect && out.bio) {
      const needle = expect.replace(/^\$/, '').toLowerCase()
      out.bioMentionsExpected = out.bio.toLowerCase().includes(needle)
    }
  } catch (err) {
    out.error = String(err?.message ?? err)
  }
  return out
}

const results = []
for (const t of targets) {
  results.push(await check(t))
}

console.log(
  JSON.stringify(
    {
      expect,
      // Stated in the output so a reader never mistakes silence for a finding.
      notAvailableWithoutApi: ['followerCount', 'joinDate', 'timeline', 'engagement'],
      accounts: results,
    },
    null,
    2,
  ),
)
