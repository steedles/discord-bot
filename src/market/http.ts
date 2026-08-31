import { log } from '../logger.js'
import type { RateLimiter } from './limiter.js'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

interface FetchJsonOptions {
  timeoutMs?: number
  retries?: number
  headers?: Record<string, string>
  /**
   * Bucket to draw from before each attempt. A retry costs a token too - it is
   * a real request, and not charging for it is how a burst of 429s turns into a
   * burst of retries that earns more 429s.
   *
   * The bucket also hears about refusals, and slows down in response.
   */
  limiter?: RateLimiter
  /** GET unless a body is given. JSON-RPC callers (Solana) always POST. */
  method?: 'GET' | 'POST'
  body?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * GET + JSON with a timeout and bounded retries. Retries on network errors and
 * 5xx with exponential backoff; 4xx fail immediately.
 *
 * **429 is not retried.** A refusal means the pace was already wrong, so asking
 * again is the one response guaranteed to make it worse - it spends two more
 * requests to learn the same thing, and it does so while every other caller is
 * still queued behind the same bucket. The correction belongs to the rate, not
 * to the request: the limiter is told, slows down, and the *next* caller
 * benefits. This one fails, which is what a rate limit means.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, retries = 2, headers = {}, limiter, method, body } = options
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1))
    await limiter?.acquire()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        method: method ?? (body !== undefined ? 'POST' : 'GET'),
        headers: {
          accept: 'application/json',
          'user-agent': 'crypto-discord-bot/0.1',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })

      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} for ${url}`, res.status, url)
        if (res.status === 429) {
          limiter?.penalise()
          throw err
        }
        if (res.status < 500) throw err
        lastError = err
        continue
      }

      return (await res.json()) as T
    } catch (err) {
      if (err instanceof HttpError && err.status < 500) throw err
      lastError = err
      log.market.debug({ url, attempt, err: String(err) }, 'fetch attempt failed')
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`)
}

/**
 * A bounded-concurrency map. Chain/vendor-agnostic on purpose - first written
 * for the rug-signature check's holder-funder lookups (docs/11-RUG-SIGNATURE.md
 * v2 §2 step 4: "parallel at width 4"), reused wherever a small, known-size
 * list needs fetching without either serialising it or firing it all at once.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  width: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  }

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => worker()))
  return results
}
