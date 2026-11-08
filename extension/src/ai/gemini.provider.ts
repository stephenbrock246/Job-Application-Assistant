/**
 * Google Gemini API provider - automatic, with a free tier.
 *
 * Uses models.generateContent with an API key from Google AI Studio (no Google
 * Cloud project or card needed for the free tier). On the free tier Google may use
 * prompts to improve its products, so contact details are redacted before sending
 * (see redact.ts) unless the user turns that off.
 *
 * Transient failures (overload, rate limit, network) are retried with backoff
 * (see retry.ts). If the primary model keeps answering 503, one attempt is made on
 * the configured fallback model - reported through `onEvent`, never silent.
 *
 * The response can contain "thought" parts from reasoning models; only the visible
 * answer parts are returned.
 */

import { redactContacts } from './redact'
import { AIHttpError, parseRetryDelay, throwIfCancelled, withRetry, type RetryOptions } from './retry'
import { getApiKey } from '@/storage/credentials'
import { preferencesSlot } from '@/storage/settings'
import type { AIProvider, AIProviderId, AIProviderStatus, CompleteOptions } from '@/shared/types/ai'

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const TIMEOUT_MS = 180_000
/** The primary must have answered "overloaded" at least this often before falling back. */
const FALLBACK_AFTER_503S = 2

export const GEMINI_MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash - newest, free tier (recommended)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro - careful writing, free tier, slower' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash - older generation, free tier' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite - fastest, free tier' },
] as const

interface GeneratePayload {
  candidates?: {
    finishReason?: string
    content?: { parts?: { text?: string; thought?: boolean }[] }
  }[]
  promptFeedback?: { blockReason?: string }
  error?: {
    message?: string
    status?: string
    details?: { '@type'?: string; retryDelay?: string }[]
  }
}

export class GeminiApiProvider implements AIProvider {
  readonly id: AIProviderId = 'gemini-api'
  readonly label = 'Google Gemini API'
  readonly mode = 'direct' as const

  /** Test seam: lets the check script run the schedule without real waiting. */
  constructor(private readonly retryTiming: Pick<RetryOptions, 'sleep' | 'random' | 'delaysMs'> = {}) {}

  async getStatus(): Promise<AIProviderStatus> {
    const [key, prefs] = await Promise.all([getApiKey('gemini'), preferencesSlot.get()])
    return key
      ? { id: this.id, label: this.label, ready: true, detail: `${prefs.geminiModel} via API` }
      : { id: this.id, label: this.label, ready: false, detail: 'Add a free API key in Settings > AI' }
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
    const [key, prefs] = await Promise.all([getApiKey('gemini'), preferencesSlot.get()])
    if (!key) throw new Error('No Gemini API key. Add one in Settings > AI.')

    const redaction = prefs.redactContacts ? redactContacts(prompt) : null
    const text = redaction?.text ?? prompt
    const primary = prefs.geminiModel
    const fallback = prefs.geminiFallbackModel.trim()

    let overloaded = 0
    const onEvent = options.onEvent

    let reply: string
    try {
      reply = await withRetry(
        async () => {
          try {
            return await this.request(key, primary, text, options.signal)
          } catch (error) {
            if (error instanceof AIHttpError && error.status === 503) overloaded += 1
            throw error
          }
        },
        {
          ...this.retryTiming,
          ...(options.signal ? { signal: options.signal } : {}),
          onRetry: (event) => onEvent?.({ type: 'retry', model: primary, ...event }),
        },
      )
      onEvent?.({ type: 'done', model: primary, fallback: false })
    } catch (error) {
      const useFallback =
        error instanceof AIHttpError &&
        error.retryable &&
        overloaded >= FALLBACK_AFTER_503S &&
        fallback &&
        fallback !== primary
      if (!useFallback) throw finalError(error, primary)

      // Exactly one attempt: the fallback is a last resort, not a second retry loop.
      throwIfCancelled(options.signal)
      onEvent?.({ type: 'fallback', from: primary, to: fallback })
      try {
        reply = await this.request(key, fallback, text, options.signal)
      } catch (fallbackError) {
        throw finalError(fallbackError, fallback, primary)
      }
      onEvent?.({ type: 'done', model: fallback, fallback: true })
    }

    return redaction ? redaction.restore(reply) : reply
  }

  /** One HTTP attempt. Throws AIHttpError for anything worth classifying. */
  private async request(key: string, model: string, text: string, cancel?: AbortSignal): Promise<string> {
    throwIfCancelled(cancel)
    // One controller aborts on either our timeout or the user's Cancel.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const onCancel = () => controller.abort()
    cancel?.addEventListener('abort', onCancel, { once: true })

    let response: Response
    try {
      response = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }] }),
        signal: controller.signal,
      })
    } catch (error) {
      // A cancel is not a timeout: it must not be retried or reported as a failure.
      throwIfCancelled(cancel)
      if ((error as Error).name === 'AbortError') {
        throw new AIHttpError(`Gemini did not answer within ${TIMEOUT_MS / 1000}s.`, 0)
      }
      throw new AIHttpError('Could not reach Gemini. Check your internet connection.', 0)
    } finally {
      clearTimeout(timer)
      cancel?.removeEventListener('abort', onCancel)
    }

    const payload = (await response.json().catch(() => ({}))) as GeneratePayload

    if (!response.ok) {
      const detail = payload.error?.message ?? `HTTP ${response.status}`
      const retryAfterMs =
        parseRetryDelay(payload.error?.details?.find((d) => d.retryDelay)?.retryDelay) ??
        parseRetryDelay(response.headers.get('retry-after'))
      if (response.status === 400 && /api key/i.test(detail)) {
        throw new AIHttpError(`Google rejected the API key. ${detail}`, 400)
      }
      if (response.status === 403) throw new AIHttpError(`This API key cannot use Gemini. ${detail}`, 403)
      if (response.status === 404) {
        throw new AIHttpError(`Model "${model}" is not available. Pick another in Settings > AI.`, 404)
      }
      throw new AIHttpError(`Gemini error (HTTP ${response.status}): ${detail}`, response.status, retryAfterMs)
    }

    if (payload.promptFeedback?.blockReason) {
      throw new Error(`Gemini declined the request (${payload.promptFeedback.blockReason}).`)
    }

    const candidate = payload.candidates?.[0]
    const reply = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')

    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini stopped before finishing (length limit). Try again, or pick a larger model.')
    }
    if (candidate?.finishReason === 'SAFETY') throw new Error('Gemini blocked the reply for safety reasons.')
    if (!reply.trim()) throw new Error('Gemini returned an empty reply.')
    return reply
  }
}

/** The message the user sees once every attempt is spent. */
function finalError(error: unknown, model: string, primary?: string): Error {
  if (!(error instanceof AIHttpError)) return error instanceof Error ? error : new Error('Gemini request failed.')
  if (!error.retryable) return error
  const tried = primary ? `${primary} and the fallback ${model}` : model
  const cause =
    error.status === 429
      ? 'the free-tier rate limit is still exceeded'
      : error.status === 0
        ? 'the connection kept failing'
        : `it is still overloaded (HTTP ${error.status})`
  return new Error(`Gemini is unavailable right now: ${cause} after several retries on ${tried}. Press Retry in a few minutes.`)
}
