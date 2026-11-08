/**
 * Provider-independent AI layer (spec section 3).
 *
 * A provider is only a *transport*: it gets a composed prompt to a model and a
 * reply back. Composing prompts and parsing replies lives in `src/ai/prompts.ts`
 * and is identical for every provider, so switching from copy/paste handoff to an
 * API key later changes how text travels, never what is asked or how the answer is
 * checked.
 *
 * Nothing outside `src/ai/` may import a concrete provider.
 */

export type AIProviderId =
  | 'claude-browser'
  | 'chatgpt-browser'
  | 'claude-api'
  | 'openai-api'
  | 'gemini-api'
  /** Resume tailoring in the user's ChatGPT chat (Preferences.tailorVia). */
  | 'chatgpt-project'
  /** Written answers and cover letters in ChatGPT (a separate chat from tailoring). */
  | 'chatgpt-answers'

/** Providers that call a model themselves - the ones autopilot can run on. */
export const DIRECT_PROVIDER_IDS: readonly AIProviderId[] = ['openai-api', 'gemini-api']

/**
 * - handoff: the user carries the prompt to their logged-in chat tab and pastes
 *            the reply back. Nothing is automated on the chat site.
 * - direct:  the extension calls the model itself (API key).
 */
export type AITransportMode = 'handoff' | 'direct'

export interface AIProviderStatus {
  id: AIProviderId
  label: string
  /** True when the provider is configured *and* believed usable right now. */
  ready: boolean
  /** Human-readable detail, shown under the provider name in the side panel. */
  detail: string
}

export interface AIProvider {
  readonly id: AIProviderId
  readonly label: string
  readonly mode: AITransportMode

  /** Cheap check used by the side panel status card. Must not throw. */
  getStatus(): Promise<AIProviderStatus>

  /** handoff only: where the user takes the prompt. */
  readonly chatUrl?: string
  /** handoff only: match pattern used to find an already-open chat tab. */
  readonly chatUrlPattern?: string

  /** direct only: send a prompt, get the model's reply text. */
  complete?(prompt: string, options?: CompleteOptions): Promise<string>
}

/** Progress from a direct provider while one logical request is in flight. */
export type AIEvent =
  /** A transient failure; waiting `delayMs` before retry `attempt` of `maxRetries`. */
  | { type: 'retry'; model: string; attempt: number; maxRetries: number; delayMs: number; status: number }
  /** The primary model stayed unavailable; one attempt on the fallback model. */
  | { type: 'fallback'; from: string; to: string }
  /** Finished; `model` produced the reply. */
  | { type: 'done'; model: string; fallback: boolean }

export interface CompleteOptions {
  onEvent?: (event: AIEvent) => void
  /** Aborts the request in flight and any wait between retries. */
  signal?: AbortSignal
  /** Progress text for a long, multi-step request. */
  onProgress?: (message: string) => void
}

/** Which model wrote a result - shown to the user, never changed silently. */
export interface GeneratedBy {
  model: string
  /** True when the configured primary model was unavailable and the fallback answered. */
  fallback: boolean
}

/** What an AI task produces; also the key it is stored under on the session. */
export type AITaskKind = 'resume' | 'coverLetter' | 'answer'

/** A prompt that has been handed to the user and is waiting for the model's reply. */
export interface PendingAITask {
  kind: AITaskKind
  prompt: string
  createdAt: number
  /** answer tasks: which form field, and its question text. */
  fieldId?: string
  question?: string
  /** What the prompt was built from, so the reply is applied to the same inputs. */
  promptProfileId?: string
  instructions?: string
  masterUploadedAt?: number
}

export interface ApplicationQuestionRequest {
  question: string
  /** Any constraint scraped from the form, e.g. "max 500 characters". */
  constraints?: string
  jobDescription: string
  company: string
  position: string
  resumeText: string
  /** Current facts from the applicant profile; they override the resume. */
  facts?: string
  /** A sample of the user's own writing, to match its voice. */
  voice?: string
}
