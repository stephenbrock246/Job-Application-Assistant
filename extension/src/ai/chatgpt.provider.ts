/**
 * OpenAI API provider - the automatic, officially supported way to use ChatGPT's
 * models from an app.
 *
 * Uses the Responses API (POST /v1/responses), which OpenAI recommends for new
 * text-generation work. Billing is per use on the user's OpenAI API account,
 * separate from a ChatGPT subscription.
 *
 * The raw REST response has no `output_text` convenience field (that is an SDK
 * helper), so the text is collected from the `output` message items.
 */

import { getApiKey } from '@/storage/credentials'
import { preferencesSlot } from '@/storage/settings'
import { throwIfCancelled } from './retry'
import type { AIProvider, AIProviderId, AIProviderStatus, CompleteOptions } from '@/shared/types/ai'

const ENDPOINT = 'https://api.openai.com/v1/responses'
/** Tailoring a full resume with a reasoning model can take a while. */
const TIMEOUT_MS = 180_000

export const OPENAI_MODELS = [
  { id: 'gpt-6-sol', label: 'GPT-6 Sol - balanced (recommended)' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra - most capable, slower' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna - fastest, cheapest' },
] as const

interface ResponsesPayload {
  status?: string
  incomplete_details?: { reason?: string } | null
  error?: { message?: string } | null
  output?: { type?: string; content?: { type?: string; text?: string }[] }[]
}

export class ChatGptApiProvider implements AIProvider {
  readonly id: AIProviderId = 'openai-api'
  readonly label = 'OpenAI API'
  readonly mode = 'direct' as const

  async getStatus(): Promise<AIProviderStatus> {
    const [key, prefs] = await Promise.all([getApiKey('openai'), preferencesSlot.get()])
    return key
      ? { id: this.id, label: this.label, ready: true, detail: `${prefs.openaiModel} via API` }
      : { id: this.id, label: this.label, ready: false, detail: 'Add an API key in Settings > AI' }
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
    const [key, prefs] = await Promise.all([getApiKey('openai'), preferencesSlot.get()])
    if (!key) throw new Error('No OpenAI API key. Add one in Settings > AI.')
    const cancel = options.signal
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
        body: JSON.stringify({ model: prefs.openaiModel, input: prompt, store: false }),
        signal: controller.signal,
      })
    } catch (error) {
      throwIfCancelled(cancel)
      if ((error as Error).name === 'AbortError') {
        throw new Error(`OpenAI did not answer within ${TIMEOUT_MS / 1000}s. Try again, or pick a faster model.`)
      }
      throw new Error('Could not reach OpenAI. Check your internet connection.')
    } finally {
      clearTimeout(timer)
      cancel?.removeEventListener('abort', onCancel)
    }

    const payload = (await response.json().catch(() => ({}))) as ResponsesPayload

    if (!response.ok) {
      const detail = payload.error?.message ?? `HTTP ${response.status}`
      if (response.status === 401) throw new Error(`OpenAI rejected the API key. ${detail}`)
      if (response.status === 429) throw new Error(`OpenAI rate limit or quota reached - check your API billing. ${detail}`)
      if (response.status === 404) throw new Error(`Model "${prefs.openaiModel}" is not available to this key. ${detail}`)
      throw new Error(`OpenAI error: ${detail}`)
    }

    const text = (payload.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('')

    if (payload.status === 'incomplete') {
      throw new Error(
        `OpenAI stopped before finishing (${payload.incomplete_details?.reason ?? 'incomplete'}). Try again, or use a larger model.`,
      )
    }
    if (!text.trim()) throw new Error('OpenAI returned an empty reply.')
    return text
  }
}
