/**
 * Runs one prompt in the user's logged-in Claude tab (claude.ai) and returns the
 * reply - and, when asked, the files Claude created in it.
 *
 * Same contract as chatgpt-runner.ts: the message starts with a reference, the
 * reply is the answer that follows the message carrying it, finished when Claude
 * stops streaming. Selectors are in one place; a failure says which step failed.
 */

import { pickCoverLetterFile, pickResumeFile, replyText } from './chatgpt-runner'
import { findComposer, sendButtonFor, typeInto } from './composer'
import type { ChatGptFile } from '@/shared/types/messages'

const SELECTORS = {
  composer: [
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][role="textbox"]',
    'fieldset div[contenteditable="true"]',
  ],
  send: ['button[aria-label="Send message"]', 'button[aria-label="Send Message"]', 'button[aria-label*="Send" i]'],
  stop: ['button[aria-label="Stop response"]', 'button[aria-label*="Stop" i]'],
  user: '[data-testid="user-message"]',
  /** Each assistant turn; data-is-streaming="true" while it is being written. */
  assistant: '[data-is-streaming]',
}

const LOGGED_OUT =
  'Claude is not logged in in this Chrome profile. Log in to claude.ai in this same window, then try again.'

let stopRequested = false

export function isClaudePage(): boolean {
  return /(^|\.)claude\.ai$/.test(location.hostname)
}

export function stopClaude(): void {
  stopRequested = true
  first<HTMLButtonElement>(SELECTORS.stop)?.click()
}

export async function askClaude(
  prompt: string,
  timeoutMs: number,
  options: { file?: boolean } = {},
): Promise<{ reply: string; ref: string; file?: ChatGptFile | null; coverLetter?: ChatGptFile | null }> {
  stopRequested = false
  const deadline = Date.now() + timeoutMs

  // 1. The message box - the chat's own, never a message being edited in the conversation.
  await waitFor(() => {
    if (/^\/login/.test(location.pathname)) throw new Error(LOGGED_OUT)
    return findComposer(SELECTORS)
  }, 30_000)
  await sleep(600)
  const composer = findComposer(SELECTORS)
  if (!composer) throw new Error("Claude's message box was not found - the page may have changed or the chat link is wrong.")

  // 2. Type, with the reference first (long messages are folded on the page).
  const ref = `JA-${Math.random().toString(36).slice(2, 8)}`
  const usersBefore = document.querySelectorAll(SELECTORS.user).length
  typeInto(composer, `(ref ${ref})\n\n${prompt}`, ref, 'Claude')
  await sleep(400)
  if (!composer.isConnected) throw new Error('Claude reloaded its message box while the message was being typed. Try again.')

  // 3. Send - with the box's own Send button.
  const send = await waitFor(() => {
    const button = sendButtonFor(composer, SELECTORS.send)
    return button && !button.disabled ? button : null
  }, 15_000)
  if (send) send.click()
  else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))

  // 4. Wait: the answer after our message exists, is no longer streaming, and has settled.
  const startDeadline = Date.now() + Math.min(240_000, timeoutMs)
  let previous = ''
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    checkStop()
    const answer = answerTo(ref, usersBefore)
    const text = answer ? replyText(answer) : ''
    const streaming = answer?.getAttribute('data-is-streaming') === 'true' || Boolean(first(SELECTORS.stop))
    if (text !== previous) {
      previous = text
      stableSince = Date.now()
    } else if (text && !streaming && Date.now() - stableSince >= 2_500) {
      if (!options.file) return { reply: text, ref }
      const files = await filesFromConversation(ref).catch(() => ({ resume: null, coverLetter: null }))
      return { reply: text, ref, file: files.resume, coverLetter: files.coverLetter }
    }
    if (!answer && Date.now() > startDeadline) throw new Error('Claude did not start answering. Check the Claude tab.')
    await sleep(500)
  }
  throw new Error(`Claude did not finish within ${Math.round(timeoutMs / 1000)}s.`)
}

/** The last assistant turn after our message (found by its reference, or as the newest one). */
function answerTo(ref: string, usersBefore: number): HTMLElement | null {
  const users = [...document.querySelectorAll<HTMLElement>(SELECTORS.user)]
  const asked =
    [...users].reverse().find((m) => (m.textContent ?? '').includes(ref)) ??
    (users.length > usersBefore ? users[users.length - 1] : undefined)
  if (!asked) return null
  let answer: HTMLElement | null = null
  for (const message of document.querySelectorAll<HTMLElement>(SELECTORS.assistant)) {
    if (asked.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) answer = message
  }
  return answer
}

// ---------------------------------------------------------------------------
// Files Claude created (its file-creation tool writes to /mnt/user-data/outputs).

interface ClaudeMessage {
  uuid?: string
  sender?: string
  text?: string
  content?: unknown[]
  files?: { file_uuid?: string; file_name?: string; path?: string }[]
  files_v2?: { file_uuid?: string; file_name?: string; path?: string }[]
}

async function filesFromConversation(ref: string): Promise<{ resume: ChatGptFile | null; coverLetter: ChatGptFile | null }> {
  const conversationId = /\/chat\/([0-9a-f-]{8,})/i.exec(location.pathname)?.[1]
  const org = await organisationId()
  if (!conversationId || !org) return { resume: null, coverLetter: null }

  for (let attempt = 0; attempt < 3; attempt++) {
    const data = await getJson<{ chat_messages?: ClaudeMessage[] }>(
      `/api/organizations/${org}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`,
    )
    const messages = data?.chat_messages ?? []
    const askedAt = messages.findIndex((m) => m.sender === 'human' && JSON.stringify(m).includes(ref))
    if (askedAt >= 0) {
      const after = messages.slice(askedAt + 1).filter((m) => m.sender === 'assistant')
      const paths = new Set<string>()
      for (const message of after) {
        for (const match of JSON.stringify(message).matchAll(/\/mnt\/user-data\/outputs\/[^"\\]+?\.(?:pdf|docx)/gi)) paths.add(match[0])
      }
      const candidates = [...paths].map((path) => ({ path, name: path.split('/').pop() ?? path }))
      const resume = pickResumeFile(candidates)
      if (resume) {
        const letter = pickCoverLetterFile(candidates)
        return {
          resume: await download(org, conversationId, resume),
          coverLetter: letter ? await download(org, conversationId, letter).catch(() => null) : null,
        }
      }
    }
    await sleep(2_000)
  }
  return { resume: null, coverLetter: null }
}

async function download(org: string, conversationId: string, file: { path: string; name: string }): Promise<ChatGptFile | null> {
  const url = `/api/organizations/${org}/conversations/${conversationId}/wiggle/download-file?path=${encodeURIComponent(file.path)}`
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok) return null
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { name: file.name, base64: btoa(binary), mime: response.headers.get('content-type') ?? undefined }
}

let org: string | null = null
async function organisationId(): Promise<string | null> {
  if (org) return org
  const fromCookie = /(?:^|;\s*)lastActiveOrg=([0-9a-f-]{8,})/i.exec(document.cookie)?.[1]
  if (fromCookie) return (org = fromCookie)
  const list = await getJson<{ uuid?: string }[]>('/api/organizations')
  return (org = list?.[0]?.uuid ?? null)
}

async function getJson<T>(path: string): Promise<T | null> {
  const response = await fetch(path, { credentials: 'include' })
  return response.ok ? ((await response.json()) as T) : null
}

// ---------------------------------------------------------------------------

function checkStop(): void {
  if (stopRequested) throw new Error('Cancelled.')
}

function first<T extends Element = Element>(selectors: string[]): T | null {
  for (const selector of selectors) {
    const element = document.querySelector<T>(selector)
    if (element) return element
  }
  return null
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    checkStop()
    const value = probe()
    if (value) return value
    await sleep(250)
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
