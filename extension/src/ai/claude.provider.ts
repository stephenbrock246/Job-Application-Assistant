/**
 * Anthropic API provider - placeholder.
 *
 * Exists so the registry proves the transport abstraction holds. When implemented
 * it becomes a `direct` provider: `complete()` posts the composed prompt to the
 * Messages API with a key stored in chrome.storage.local (an API key, never an
 * account password). Prompt composition and reply parsing need no changes.
 */

import type { AIProvider, AIProviderId, AIProviderStatus } from '@/shared/types/ai'

export class ClaudeApiProvider implements AIProvider {
  readonly id: AIProviderId = 'claude-api'
  readonly label = 'Claude (API key)'
  readonly mode = 'direct' as const

  async getStatus(): Promise<AIProviderStatus> {
    return {
      id: this.id,
      label: this.label,
      ready: false,
      detail: 'Not available yet - use copy/paste',
    }
  }

  async complete(): Promise<string> {
    throw new Error('The Claude API provider is not implemented yet. Choose a copy/paste provider in Settings > AI.')
  }
}
