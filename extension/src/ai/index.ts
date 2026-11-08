/**
 * Provider registry - the only module the rest of the app imports from `@/ai`.
 */

import { HandoffProvider } from './browser-session.provider'
import { ClaudeApiProvider } from './claude.provider'
import { ChatGptApiProvider } from './chatgpt.provider'
import { GeminiApiProvider } from './gemini.provider'
import { ChatGptProjectProvider, parseChatGptProjectUrl } from './chatgpt-project.provider'
import { preferencesSlot } from '@/storage/settings'
import type { AIProvider, AIProviderId } from '@/shared/types/ai'
import type { Preferences } from '@/shared/types/settings'

export * from './ai-provider.interface'

const providers: Record<AIProviderId, () => AIProvider> = {
  'claude-browser': () => new HandoffProvider('claude-browser'),
  'chatgpt-browser': () => new HandoffProvider('chatgpt-browser'),
  'claude-api': () => new ClaudeApiProvider(),
  'openai-api': () => new ChatGptApiProvider(),
  'gemini-api': () => new GeminiApiProvider(),
  'chatgpt-project': () => new ChatGptProjectProvider('tailor'),
  'chatgpt-answers': () => new ChatGptProjectProvider('answers'),
}

export const AI_PROVIDER_OPTIONS: { id: AIProviderId; label: string; note: string; available: boolean }[] = [
  {
    id: 'gemini-api',
    label: 'Google Gemini (automatic, free tier)',
    note: 'Free API key from Google AI Studio. Fully automatic. Your contact details are hidden from Google.',
    available: true,
  },
  {
    id: 'openai-api',
    label: 'OpenAI API (automatic)',
    note: 'ChatGPT models via your OpenAI API key. Fully automatic; billed per use by OpenAI.',
    available: true,
  },
]

export { OPENAI_MODELS } from './chatgpt.provider'
export { GEMINI_MODELS } from './gemini.provider'
export {
  chatSite,
  chatSiteName,
  checkChatGptLink,
  isChatLink,
  isProjectLink,
  parseChatGptProjectUrl,
} from './chatgpt-project.provider'
export { DIRECT_PROVIDER_IDS } from '@/shared/types/ai'

export function getProvider(id: AIProviderId): AIProvider {
  return (providers[id] ?? providers['gemini-api'])()
}

/** True when the AI runs on an API key (Gemini or OpenAI) rather than the user's chats. */
export function usesApiKey(prefs: Preferences): boolean {
  return prefs.aiMode === 'api'
}

/** The API provider in use when `usesApiKey`. */
export function apiProviderId(prefs: Preferences): 'gemini-api' | 'openai-api' {
  return prefs.aiProviderId === 'openai-api' ? 'openai-api' : 'gemini-api'
}

/** The provider for written answers: the API key's, or the answers chat. */
export async function getActiveProvider(): Promise<AIProvider> {
  const prefs = await preferencesSlot.get()
  return usesApiKey(prefs) ? getProvider(apiProviderId(prefs)) : getProvider('chatgpt-answers')
}

/** True when resume tailoring goes to the user's ChatGPT project. */
export function tailorsViaProject(prefs: Preferences): boolean {
  return !usesApiKey(prefs) && prefs.tailorVia === 'chatgpt-project' && Boolean(parseChatGptProjectUrl(prefs.chatgptProjectUrl))
}

/** True when ChatGPT gets only the job description and creates the resume PDF itself. */
export function usesGptFile(prefs: Preferences): boolean {
  return tailorsViaProject(prefs) && prefs.tailorOutput === 'file'
}

/** True when the tailoring chat writes the CV's text and the extension builds the files. */
export function usesChatContent(prefs: Preferences): boolean {
  return tailorsViaProject(prefs) && prefs.tailorOutput !== 'file'
}

/**
 * The provider for one kind of task. With an API key, everything goes to it
 * (Gemini or OpenAI). Otherwise everything runs in the user's own chats: the
 * resume in their tailoring chat, written answers and cover letters in a separate one.
 */
export async function getProviderFor(kind: string): Promise<AIProvider> {
  const prefs = await preferencesSlot.get()
  if (usesApiKey(prefs)) return getProvider(apiProviderId(prefs))
  if (kind === 'resume' && tailorsViaProject(prefs)) return getProvider('chatgpt-project')
  return getProvider('chatgpt-answers')
}
