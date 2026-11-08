/**
 * Retrying transient AI API failures.
 *
 * Only failures that can succeed on a second try are retried: rate limiting (429),
 * request timeout (408), server errors (500/502/503/504), network drops and our
 * own timeout. Anything that means "fix your setup" (400 bad request / bad key,
 * 401, 403, 404 unknown model) fails at once - retrying it only wastes minutes.
 *
 * Delays grow ~2s, 4s, 8s, 16s, 30s with +-20% jitter, so many clients recovering
 * from the same outage do not hammer the API in lockstep. When the server says how
 * long to wait, that is honoured (capped). The retry count is fixed; it can never
 * loop forever.
 */

export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
export const DEFAULT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000]
/** Never wait longer than this for one retry, whatever the server suggests. */
const MAX_DELAY_MS = 60_000

/** An HTTP or network failure from an AI API, classified for retrying. */
export class AIHttpError extends Error {
  readonly retryable: boolean
  constructor(
    message: string,
    /** HTTP status, or 0 for a network failure / timeout. */
    readonly status: number,
    /** Server-suggested wait, when it gave one. */
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'AIHttpError'
    this.retryable = status === 0 || RETRYABLE_STATUS.has(status)
  }
}

/** The user pressed Cancel. Not an error to report - the caller just stops. */
export class AICancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'AICancelledError'
  }
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AICancelledError()
}

/** A wait that ends early - with AICancelledError - when the signal fires. */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AICancelledError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AICancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RetryEvent {
  /** 1-based number of the retry about to happen. */
  attempt: number
  maxRetries: number
  delayMs: number
  status: number
}

export interface RetryOptions {
  delaysMs?: readonly number[]
  onRetry?: (event: RetryEvent) => void
  /** Cancels the waits between attempts and stops further attempts. */
  signal?: AbortSignal
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

/**
 * Runs `request`, retrying retryable AIHttpErrors per the delay schedule.
 * The last error is rethrown once retries are exhausted, annotated with how many
 * attempts were made.
 */
export async function withRetry<T>(request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS
  const sleep = options.sleep ?? cancellableSleep
  const random = options.random ?? Math.random

  for (let attempt = 0; ; attempt += 1) {
    throwIfCancelled(options.signal)
    try {
      return await request()
    } catch (error) {
      throwIfCancelled(options.signal)
      const retryable = error instanceof AIHttpError && error.retryable
      if (!retryable || attempt >= delays.length) throw error

      const base = delays[attempt]!
      const jittered = Math.round(base * (0.8 + random() * 0.4))
      const delayMs = Math.min(MAX_DELAY_MS, Math.max(jittered, error.retryAfterMs ?? 0))
      options.onRetry?.({ attempt: attempt + 1, maxRetries: delays.length, delayMs, status: error.status })
      await sleep(delayMs, options.signal)
    }
  }
}

/** "37s" / "1.5s" (Google RetryInfo) or a Retry-After header in seconds -> ms. */
export function parseRetryDelay(value: string | null | undefined): number | undefined {
  if (!value) return undefined
  const seconds = Number.parseFloat(value.replace(/s$/, ''))
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined
}
