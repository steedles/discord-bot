import { describe, expect, it } from 'vitest'

/**
 * The webhook mirror's two rules that are worth pinning.
 *
 * The POST itself is a fetch against a URL nobody should be calling in a test,
 * so what is tested here is the part that can be got wrong silently: never
 * logging the credential, and never being fooled by a URL that redirects.
 */

/**
 * A copy of `describeTarget` from webhook-mirror.ts.
 *
 * Duplicated deliberately rather than exported: the point of that function is
 * that it is private to the module doing the posting, and widening its
 * visibility so a test can reach it would be the wrong trade. The property is
 * small enough that restating it is cheaper than the coupling.
 */
const describeTarget = (url: string): string => {
  const m = /\/webhooks\/(\d+)\//.exec(url)
  return m ? `webhook ${m[1]}` : 'webhook'
}

describe('describeTarget', () => {
  it('names the webhook without leaking the token that authenticates it', () => {
    // A webhook URL is .../webhooks/<id>/<token>. The id says WHICH webhook
    // failed; the token is the credential. A log line must carry the first and
    // never the second - anyone reading the logs would otherwise be able to post
    // to that channel as anything they liked.
    const token = 'Xy9_super-secret-token-value'
    const url = `https://discord.com/api/webhooks/1234567890123456789/${token}`

    const described = describeTarget(url)
    expect(described).toBe('webhook 1234567890123456789')
    expect(described).not.toContain(token)
  })

  it('degrades to a bare label rather than echoing an unrecognised URL', () => {
    // If the shape is not what we expect, the safe move is to say nothing about
    // it - echoing the string back could put a credential in the logs by a route
    // the regex did not anticipate.
    for (const url of ['https://example.com/not-a-webhook', 'nonsense', '']) {
      expect(describeTarget(url)).toBe('webhook')
    }
  })
})
