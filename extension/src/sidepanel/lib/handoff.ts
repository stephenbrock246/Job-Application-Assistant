/**
 * Copy/paste handoff mechanics: clipboard and the chat tab.
 *
 * The chat tab is only ever opened or focused - never read or scripted.
 */

import type { AIProvider } from '@/shared/types/ai'

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text)
}

export async function readClipboard(): Promise<string> {
  return navigator.clipboard.readText()
}

/** Focuses an open chat tab for this provider, or opens a new chat. */
export async function openChat(provider: AIProvider): Promise<void> {
  if (!provider.chatUrl) return
  const [existing] = provider.chatUrlPattern
    ? await chrome.tabs.query({ url: provider.chatUrlPattern })
    : []
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true })
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true })
    return
  }
  await chrome.tabs.create({ url: provider.chatUrl, active: true })
}
