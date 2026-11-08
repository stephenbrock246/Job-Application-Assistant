/**
 * HumanGPT humanizer - an optional rewrite of drafted written answers.
 *
 * POST https://api.humangpt.io/v1/humanize with the user's own API key. The
 * request carries only the answer text (never the resume), with contact details
 * redacted, and a `freeze` list of words that must survive the rewrite exactly -
 * names, places, numbers, technologies, [ADD: ...] gaps. What comes back is
 * fact-checked again by the caller, because a rewrite can still shift meaning.
 */

import { redactContacts } from './redact'
import { AIHttpError, parseRetryDelay, throwIfCancelled, withRetry } from './retry'
import { getApiKey } from '@/storage/credentials'

const ENDPOINT = 'https://api.humangpt.io/v1/humanize'
const TIMEOUT_MS = 90_000
/** HumanGPT rejects shorter input. */
export const HUMANIZER_MIN_WORDS = 15

export type HumanizerMode = 'light' | 'medium' | 'heavy'

export interface HumanizeResult {
  text: string
  /** GPTZero probability that the result reads as AI (0-1, lower is better). */
  aiScore: number | null
  /** HumanGPT could not make it read as human after its own retries. */
  resisted: boolean
  wordsRemaining: number | null
}

interface HumanizePayload {
  output?: string
  ai_score?: number
  resisted?: boolean
  usage?: { words_remaining?: number }
  error?: string | { message?: string }
  message?: string
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

export async function humanize(
  text: string,
  options: { mode: HumanizerMode; freeze: string[]; signal?: AbortSignal },
): Promise<HumanizeResult> {
  const key = await getApiKey('humangpt')
  if (!key) throw new Error('No HumanGPT API key. Add one in Settings > AI > Humanizer.')

  const redaction = redactContacts(text)
  // Placeholders like [EMAIL-1] must come back untouched to be restored.
  const freeze = [...new Set([...options.freeze, ...(redaction.text.match(/\[(?:EMAIL|LINK|PHONE)-\d+\]/g) ?? [])])]

  const payload = await withRetry(() => request(key, redaction.text, options.mode, freeze, options.signal), {
    // HumanGPT's free tier is small; a short schedule is enough for a rate-limit blip.
    delaysMs: [3_000, 10_000],
    ...(options.signal ? { signal: options.signal } : {}),
  })

  const output = payload.output?.trim()
  if (!output) throw new Error('HumanGPT returned no text.')
  return {
    text: redaction.restore(output),
    aiScore: typeof payload.ai_score === 'number' ? payload.ai_score : null,
    resisted: Boolean(payload.resisted),
    wordsRemaining: typeof payload.usage?.words_remaining === 'number' ? payload.usage.words_remaining : null,
  }
}

async function request(
  key: string,
  text: string,
  mode: HumanizerMode,
  freeze: string[],
  cancel?: AbortSignal,
): Promise<HumanizePayload> {
  throwIfCancelled(cancel)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onCancel = () => controller.abort()
  cancel?.addEventListener('abort', onCancel, { once: true })

  let response: Response
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ text, mode, purpose: 'general', freeze, language: 'en' }),
      signal: controller.signal,
    })
  } catch (error) {
    throwIfCancelled(cancel)
    if ((error as Error).name === 'AbortError') throw new AIHttpError(`HumanGPT did not answer within ${TIMEOUT_MS / 1000}s.`, 0)
    throw new AIHttpError('Could not reach HumanGPT. Check your internet connection.', 0)
  } finally {
    clearTimeout(timer)
    cancel?.removeEventListener('abort', onCancel)
  }

  const payload = (await response.json().catch(() => ({}))) as HumanizePayload
  if (response.ok) return payload

  const detail =
    (typeof payload.error === 'string' ? payload.error : payload.error?.message) ?? payload.message ?? `HTTP ${response.status}`
  const messages: Record<number, string> = {
    401: 'HumanGPT rejected the API key.',
    402: 'Your HumanGPT word quota is used up (the free plan allows 500 words a day).',
    403: 'Your HumanGPT account is restricted.',
    413: 'The answer is too long for your HumanGPT plan.',
  }
  throw new AIHttpError(
    `${messages[response.status] ?? `HumanGPT error (HTTP ${response.status}).`} ${detail}`.trim(),
    response.status,
    parseRetryDelay(response.headers.get('retry-after')),
  )
}
