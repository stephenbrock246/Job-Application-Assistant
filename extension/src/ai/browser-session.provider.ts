/**
 * Copy/paste handoff providers.
 *
 * These use the user's *already logged-in* claude.ai / chatgpt.com account without
 * automating those sites: the extension composes the full prompt and copies it,
 * the user pastes it into their chat and pastes the reply back into the panel.
 *
 * Deliberately not automated. Driving a chat UI's DOM breaks whenever the site
 * changes, and both services' consumer terms prohibit scripted access. The handoff
 * costs two pastes and never breaks.
 *
 * Nothing here stores a password or reads the chat page.
 */

import type { AIProvider, AIProviderId, AIProviderStatus } from '@/shared/types/ai'

interface HandoffConfig {
  id: AIProviderId
  label: string
  site: string
  chatUrl: string
  chatUrlPattern: string
}

const CONFIGS: Record<'claude-browser' | 'chatgpt-browser', HandoffConfig> = {
  'claude-browser': {
    id: 'claude-browser',
    label: 'Claude (copy/paste)',
    site: 'claude.ai',
    chatUrl: 'https://claude.ai/new',
    chatUrlPattern: 'https://claude.ai/*',
  },
  'chatgpt-browser': {
    id: 'chatgpt-browser',
    label: 'ChatGPT (copy/paste)',
    site: 'chatgpt.com',
    chatUrl: 'https://chatgpt.com/',
    chatUrlPattern: 'https://chatgpt.com/*',
  },
}

export class HandoffProvider implements AIProvider {
  readonly id: AIProviderId
  readonly label: string
  readonly mode = 'handoff' as const
  readonly chatUrl: string
  readonly chatUrlPattern: string
  private readonly site: string

  constructor(kind: 'claude-browser' | 'chatgpt-browser') {
    const config = CONFIGS[kind]
    this.id = config.id
    this.label = config.label
    this.chatUrl = config.chatUrl
    this.chatUrlPattern = config.chatUrlPattern
    this.site = config.site
  }

  async getStatus(): Promise<AIProviderStatus> {
    // Always usable: the only requirement is that the user can open the chat site.
    return {
      id: this.id,
      label: this.label,
      ready: true,
      detail: `Copy/paste via ${this.site}`,
    }
  }
}
