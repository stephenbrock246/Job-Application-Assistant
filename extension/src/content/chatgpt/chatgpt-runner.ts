/**
 * Runs one prompt in the user's logged-in ChatGPT tab and returns the reply.
 *
 * Used only for resume tailoring through the user's ChatGPT project, at their
 * request: type the prompt into the message box, send it, wait until ChatGPT has
 * finished answering, read the last reply.
 *
 * chatgpt.com changes its markup from time to time, so every element is found
 * through a short list of selectors, and every failure says which step failed -
 * when a step breaks it is one selector to update here, nothing else.
 */

import { pickCoverLetterFile, pickResumeFile } from '@/shared/utils/pick-files'
import { findComposer, sendButtonFor, typeInto } from './composer'
import type { ChatGptFile } from '@/shared/types/messages'

const SELECTORS = {
  composer: [
    '#prompt-textarea',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea[data-id="root"]',
    'form textarea',
  ],
  send: [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send" i]',
  ],
  stop: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop" i]'],
  assistant: '[data-message-author-role="assistant"]',
  user: '[data-message-author-role="user"]',
  login: ['[data-testid="login-button"]', 'a[href*="/auth/login"]', 'button[data-testid="welcome-login-button"]'],
}

const LIMIT_TEXT = /(reached (our|the|your) (current )?(usage )?(limit|cap)|usage cap|too many requests|you've hit (your|the) limit)/i
const ERROR_TEXT = /(something went wrong|network error|an error occurred|there was an error generating)/i

const LOGGED_OUT =
  'ChatGPT is not logged in in this Chrome profile. Log in to chatgpt.com in this same window (the profile where the extension is installed), then press Retry.'

let stopRequested = false

function loggedOut(): boolean {
  if (/^\/(auth\/)?log-?in/.test(location.pathname) || location.hostname.startsWith('auth.')) return true
  if (findComposer(SELECTORS)) return false
  return Boolean(first(SELECTORS.login)) || /log in or sign up/i.test(document.body?.innerText ?? document.body?.textContent ?? '')
}

export function isChatGptPage(): boolean {
  return /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(location.hostname)
}

export function stopChatGpt(): void {
  stopRequested = true
  first<HTMLButtonElement>(SELECTORS.stop)?.click()
}

export async function askChatGpt(
  prompt: string,
  timeoutMs: number,
  options: { file?: boolean } = {},
): Promise<{ reply: string; ref: string; file?: ChatGptFile | null; coverLetter?: ChatGptFile | null }> {
  if (!isChatGptPage()) throw new Error('This tab is not ChatGPT.')
  stopRequested = false
  const deadline = Date.now() + timeoutMs
  // The answer is finished; when files were asked for, fetch the ones it created.
  const finish = async (reply: string) => {
    if (!options.file) return { reply, ref }
    const files = await filesFromConversation(ref).catch(() => ({ resume: null, coverLetter: null }))
    return { reply, ref, file: files.resume, coverLetter: files.coverLetter }
  }

  // 1. The message box (the page is a single-page app; it renders after load) -
  // the chat's own box, never an editable answer or canvas in the conversation.
  // A logged-out visit is sent to the login page: say so at once, not after a timeout.
  await waitFor(() => {
    if (loggedOut()) throw new Error(LOGGED_OUT)
    return findComposer(SELECTORS)
  }, 30_000)
  // An opened chat re-renders its box while the history loads: let it settle, then look again.
  await sleep(600)
  const composer = findComposer(SELECTORS)
  if (!composer) {
    if (loggedOut()) throw new Error(LOGGED_OUT)
    throw new Error('ChatGPT\'s message box was not found - the page may have changed or the project link is wrong.')
  }

  // 2. Type the prompt. An existing chat already holds earlier answers (and may
  // still be loading them), so the message carries a reference: the reply is the
  // answer that follows the message with this reference, never an older one.
  // The reference goes first: ChatGPT collapses a long message ("Show more"), so
  // the end of it may not be on the page.
  const ref = `JA-${Math.random().toString(36).slice(2, 8)}`
  const usersBefore = document.querySelectorAll(SELECTORS.user).length
  typeInto(composer, `(ref ${ref})\n\n${prompt}`, ref, 'ChatGPT')
  await sleep(400)
  if (!composer.isConnected) throw new Error('ChatGPT reloaded its message box while the message was being typed. Press Retry.')

  // 3. Send it - with the box's own Send button.
  const send = await waitFor(() => {
    const button = sendButtonFor(composer, SELECTORS.send)
    return button && !button.disabled ? button : null
  }, 15_000)
  if (send) send.click()
  else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  checkStop()

  // 4. Wait for the answer. First choice: ChatGPT's own record of the conversation
  // (what the page loads), which says when the answer is finished and holds all of
  // it. If that cannot be read, the page: the answer after our message, no Stop
  // button, text unchanged for a few seconds.
  const startDeadline = Date.now() + Math.min(240_000, timeoutMs)
  let record: ConversationAnswer | null = null
  let recordCheckedAt = 0
  let previous = ''
  let stableSince = Date.now()
  let seenAnswer = false
  while (Date.now() < deadline) {
    checkStop()

    if (Date.now() - recordCheckedAt >= 2_000) {
      recordCheckedAt = Date.now()
      record = await answerFromConversation(ref).catch(() => null)
      if (record?.done && record.text) return finish(record.text)
    }
    if (record?.found) {
      // The record is readable and has our message: it decides when the answer is
      // finished. Should it not mark the end, a reply unchanged for a while with no
      // Stop button on the page counts as finished.
      seenAnswer = true
      if (record.text !== previous) {
        previous = record.text ?? ''
        stableSince = Date.now()
      } else if (record.text && !first(SELECTORS.stop) && Date.now() - stableSince >= 8_000) {
        return finish(record.text)
      }
      await sleep(500)
      continue
    }

    // Looked up each time: ChatGPT may re-render the message element while streaming.
    const answer = answerTo(ref, usersBefore)
    const text = answer ? replyText(answer) : ''
    if (text) seenAnswer = true
    const generating = Boolean(first(SELECTORS.stop))
    if (text !== previous) {
      previous = text
      stableSince = Date.now()
    } else if (text && !generating && Date.now() - stableSince >= 2_500) {
      return finish(text)
    }
    if (!seenAnswer && Date.now() > startDeadline) {
      pageProblem()
      throw new Error(`ChatGPT did not start answering. ${diagnose(ref, usersBefore, record)}`)
    }
    await sleep(500)
  }
  pageProblem()
  throw new Error(`ChatGPT did not finish within ${Math.round(timeoutMs / 1000)}s. ${diagnose(ref, usersBefore, record)}`)
}

/** What the runner could see, for the error message - enough to find what changed. */
function diagnose(ref: string, usersBefore: number, record: ConversationAnswer | null): string {
  const users = document.querySelectorAll(SELECTORS.user).length
  const assistants = document.querySelectorAll(SELECTORS.assistant).length
  const refOnPage = (document.body?.textContent ?? '').includes(ref)
  const conversation = chatIdFromUrl() ? (record ? (record.found ? 'message found' : 'message not found') : 'unreadable') : 'no chat id in URL'
  return `[page: ${users} user (was ${usersBefore}) / ${assistants} assistant messages, reference ${refOnPage ? 'shown' : 'not shown'}; conversation record: ${conversation}]`
}

// ---------------------------------------------------------------------------

/**
 * Clicks the Download links/buttons in the answer to our message - the way the
 * user would - so the browser downloads the files. The panel collects them from
 * Chrome's downloads. Returns how many were clicked.
 */
export function clickDownloads(ref: string, assistantSelector = SELECTORS.assistant, userSelector = SELECTORS.user): number {
  const users = [...document.querySelectorAll<HTMLElement>(userSelector)]
  const asked = users.reverse().find((m) => (m.textContent ?? '').includes(ref))
  const assistants = [...document.querySelectorAll<HTMLElement>(assistantSelector)]
  const answers = asked ? assistants.filter((m) => asked.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) : assistants.slice(-1)
  let clicked = 0
  const seen = new Set<string>()
  for (const answer of answers) {
    for (const element of answer.querySelectorAll<HTMLElement>('a, button')) {
      const label = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`.trim()
      const href = element.getAttribute('href') ?? ''
      const isDownload = /download/i.test(label) || href.startsWith('sandbox:') || element.hasAttribute('download')
      if (!isDownload) continue
      const key = `${label}|${href}`
      if (seen.has(key)) continue
      seen.add(key)
      element.click()
      clicked++
    }
  }
  return clicked
}

/**
 * The answer to our message, if it exists yet: the last assistant message after it
 * (a thinking model may show more than one). Our message is the one carrying
 * `ref`, or - if its text is collapsed - the user message added since sending.
 */
function answerTo(ref: string, usersBefore: number): HTMLElement | null {
  const users = [...document.querySelectorAll<HTMLElement>(SELECTORS.user)]
  const asked =
    users.reverse().find((m) => (m.textContent ?? '').includes(ref)) ??
    (users.length > usersBefore ? users[0] : undefined)
  if (!asked) return null
  let answer: HTMLElement | null = null
  for (const message of document.querySelectorAll<HTMLElement>(SELECTORS.assistant)) {
    if (asked.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) answer = message
  }
  return answer
}

interface ConversationNode {
  parent?: string | null
  children?: string[]
  message?: {
    author?: { role?: string }
    content?: { content_type?: string; parts?: unknown[] }
    metadata?: { attachments?: { id?: string; name?: string; mime_type?: string }[] }
    status?: string
    end_turn?: boolean | null
  } | null
}

export interface ConversationAnswer {
  /** Our message (carrying the reference) is in the record. */
  found: boolean
  /** The answer so far (plain text only - never the model's "thinking"). */
  text: string | null
  /** The answer is complete. */
  done: boolean
}

function chatIdFromUrl(): string | null {
  return /\/c\/([0-9a-f-]{8,})/i.exec(location.pathname)?.[1] ?? null
}

let accessToken: { value: string; at: number } | null = null

/** GET on ChatGPT's own API with the user's logged-in session. Null if refused. */
async function backendGet<T>(path: string): Promise<T | null> {
  if (!accessToken || Date.now() - accessToken.at > 10 * 60_000) {
    const session = (await fetch('/api/auth/session', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null))) as {
      accessToken?: string
    } | null
    if (!session?.accessToken) return null
    accessToken = { value: session.accessToken, at: Date.now() }
  }
  const response = await fetch(path, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${accessToken.value}` },
  })
  if (response.status === 401) accessToken = null
  if (!response.ok) return null
  return (await response.json()) as T
}

async function conversationMapping(): Promise<{ id: string; mapping: Record<string, ConversationNode> } | null> {
  const id = chatIdFromUrl()
  if (!id) return null
  const data = await backendGet<{ mapping?: Record<string, ConversationNode> }>(`/backend-api/conversation/${id}`)
  return data?.mapping ? { id, mapping: data.mapping } : null
}

/**
 * The answer from ChatGPT's own record of the conversation (what the page itself
 * loads), with the user's logged-in session. Null when the record cannot be read;
 * the caller then reads the page.
 */
export async function answerFromConversation(ref: string): Promise<ConversationAnswer | null> {
  const conversation = await conversationMapping()
  return conversation ? findAnswer(conversation.mapping, ref) : null
}

/** A file ChatGPT created in its answer, as it appears in the conversation record. */
export type FileCandidate =
  /** A file its code wrote. `messageIds`: the answer's messages, the one naming it first. */
  | { kind: 'sandbox'; messageId: string; messageIds: string[]; path: string; name: string }
  | { kind: 'file'; fileId: string; name: string }

const SANDBOX_PATH = /(?:sandbox:)?(\/mnt\/data\/[^"\\\n)\]<>]+?\.(?:pdf|docx?))/gi
const FILE_POINTER = /(?:file-service|sediment):\/\/([A-Za-z0-9_-]{6,})|"(?:file_id|asset_pointer_id)"\s*:\s*"(file[-_][A-Za-z0-9_-]{6,})"/g

/**
 * Files in the answer to our message, newest last. ChatGPT changes how it shows
 * files (markdown links, file cards, attachments), so every message of the answer
 * - text, code, tool output and metadata - is searched for a document path
 * ("/mnt/data/Tailored CV.pdf", spaces allowed) or a stored-file id.
 */
export function findFiles(mapping: Record<string, ConversationNode>, ref: string): FileCandidate[] {
  const askedId = Object.keys(mapping).find((key) => {
    const node = mapping[key]!
    const parts = node.message?.content?.parts ?? []
    return node.message?.author?.role === 'user' && parts.some((p) => typeof p === 'string' && p.includes(ref))
  })
  if (!askedId) return []

  // The answer's messages, in order.
  const answer: { id: string; json: string; attachments: { id?: string; name?: string }[] }[] = []
  let current = mapping[askedId]!
  for (let guard = 0; guard < 100 && current.children?.length; guard++) {
    const key = current.children[current.children.length - 1]!
    const next = mapping[key]
    if (!next || next.message?.author?.role === 'user') break
    if (next.message) {
      answer.push({ id: key, json: JSON.stringify(next.message), attachments: next.message.metadata?.attachments ?? [] })
    }
    current = next
  }
  // Later messages first: the final answer's link is the most likely to resolve.
  const ids = answer.map((m) => m.id).reverse()

  const found: FileCandidate[] = []
  for (const message of answer) {
    for (const match of message.json.matchAll(SANDBOX_PATH)) {
      let path = match[1]!.trim()
      try {
        path = decodeURIComponent(path)
      } catch {
        /* already plain */
      }
      if (found.some((f) => f.kind === 'sandbox' && f.path === path)) continue
      found.push({
        kind: 'sandbox',
        messageId: message.id,
        messageIds: [message.id, ...ids.filter((id) => id !== message.id)],
        path,
        name: path.split('/').pop() ?? 'file',
      })
    }
    for (const attachment of message.attachments) {
      if (attachment?.id && !found.some((f) => f.kind === 'file' && f.fileId === attachment.id)) {
        found.push({ kind: 'file', fileId: attachment.id, name: attachment.name ?? attachment.id })
      }
    }
    for (const match of message.json.matchAll(FILE_POINTER)) {
      const fileId = match[1] ?? match[2]!
      if (!found.some((f) => f.kind === 'file' && f.fileId === fileId)) found.push({ kind: 'file', fileId, name: fileId })
    }
  }
  return found
}

export { pickCoverLetterFile, pickResumeFile } from '@/shared/utils/pick-files'

/**
 * The CV (and cover letter, if any) ChatGPT created for our message. Every file
 * found is downloaded (a stored file's real name is only known then), and the two
 * are picked by name. Nothing found yet: the record can trail the page briefly.
 */
async function filesFromConversation(ref: string): Promise<{ resume: ChatGptFile | null; coverLetter: ChatGptFile | null }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const conversation = await conversationMapping()
    if (conversation) {
      const candidates = findFiles(conversation.mapping, ref).slice(-6)
      const files: ChatGptFile[] = []
      for (const candidate of candidates) {
        const file = await downloadFile(conversation.id, candidate).catch(() => null)
        if (file && /\.(pdf|docx?)$/i.test(file.name)) files.push(file)
        // A stored file whose name says nothing: keep it as a possible CV.
        else if (file && candidate.kind === 'file' && !/\.[a-z0-9]{2,5}$/i.test(file.name)) files.push({ ...file, name: `${file.name}.pdf` })
      }
      const resume = pickResumeFile(files)
      if (resume) return { resume, coverLetter: pickCoverLetterFile(files) }
    }
    await sleep(2_500)
  }
  return { resume: null, coverLetter: null }
}

async function downloadFile(conversationId: string, file: FileCandidate): Promise<ChatGptFile | null> {
  let info: { download_url?: string; file_name?: string } | null = null
  if (file.kind === 'sandbox') {
    // Which message a file link resolves against varies; try the answer's messages in turn.
    for (const messageId of file.messageIds) {
      info = await backendGet<{ download_url?: string; file_name?: string }>(
        `/backend-api/conversation/${conversationId}/interpreter/download?message_id=${encodeURIComponent(messageId)}&sandbox_path=${encodeURIComponent(file.path)}`,
      ).catch(() => null)
      if (info?.download_url) break
    }
  } else {
    info =
      (await backendGet(`/backend-api/files/download/${file.fileId}?conversation_id=${conversationId}&inline=false`)) ??
      (await backendGet(`/backend-api/files/${file.fileId}/download`))
  }
  if (!info?.download_url) return null
  const name = info.file_name ?? file.name
  const url = new URL(info.download_url, location.origin).toString()
  try {
    const response = await fetch(url, { credentials: url.startsWith(location.origin) ? 'include' : 'omit' })
    if (!response.ok) throw new Error(String(response.status))
    const bytes = new Uint8Array(await response.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return { name, mime: response.headers.get('content-type') ?? undefined, base64: btoa(binary) }
  } catch {
    // Another origin may refuse the page; the extension can fetch it instead.
    return { name, downloadUrl: url }
  }
}

/** Our message by its reference, then the newest branch below it. */
export function findAnswer(mapping: Record<string, ConversationNode>, ref: string): ConversationAnswer {
  const text = (node: ConversationNode | undefined) =>
    node?.message?.content?.content_type === 'text'
      ? (node.message.content.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n')
      : ''
  const asked = Object.values(mapping).find((node) => node.message?.author?.role === 'user' && text(node).includes(ref))
  if (!asked) return { found: false, text: null, done: false }

  let reply: ConversationNode | null = null
  let current = asked
  for (let guard = 0; guard < 100 && current.children?.length; guard++) {
    const next = mapping[current.children[current.children.length - 1]!]
    if (!next || next.message?.author?.role === 'user') break
    if (next.message?.author?.role === 'assistant' && text(next).trim()) reply = next
    current = next
  }
  if (!reply) return { found: true, text: null, done: false }
  const message = reply.message!
  // Finished: the record says so, and nothing follows it on this branch yet.
  const done =
    (message.status === 'finished_successfully' || message.end_turn === true) &&
    message.end_turn !== false &&
    !(current !== reply && current.message?.author?.role === 'assistant' && current.message.status === 'in_progress')
  return { found: true, text: text(reply).trim(), done }
}

/**
 * The reply's text. A JSON answer usually sits in a code block whose header adds
 * "json" and "Copy code" to innerText, so the largest code block wins when there is one.
 */
export function replyText(message: HTMLElement): string {
  const blocks = [...message.querySelectorAll('pre')]
    .map((pre) => (pre.querySelector('code') ?? pre).textContent?.trim() ?? '')
    .filter((text) => text.includes('{'))
    .sort((a, b) => b.length - a.length)
  if (blocks[0]) return blocks[0]
  return (message.innerText ?? message.textContent ?? '').trim()
}

function checkStop(): void {
  if (stopRequested) throw new Error('Cancelled.')
}

/** A usage-limit or error banner on the page, reported in ChatGPT's own words. */
function pageProblem(): void {
  const text = (document.body?.innerText ?? '').slice(-4_000)
  const limit = LIMIT_TEXT.exec(text)
  if (limit) throw new Error(`ChatGPT says you have ${limit[0].toLowerCase()} - try again later.`)
  const error = ERROR_TEXT.exec(text)
  if (error) throw new Error(`ChatGPT shows an error: "${error[0]}".`)
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
