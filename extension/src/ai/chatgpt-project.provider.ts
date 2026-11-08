/**
 * Resume tailoring through the user's own ChatGPT chat or project, in their
 * logged-in tab.
 *
 * The chat (or project) holds the user's tailoring instructions and CV. For each
 * job the extension opens the link - a chat link continues that conversation, a
 * project link starts a new chat in the project - and types the prompt -
 * numbered resume paragraphs plus the job description, asking for the JSON edits
 * the .docx engine applies - waits for the answer and reads it back. The page work
 * is done by content/chatgpt/chatgpt-runner.ts.
 *
 * Runs in the side panel. Written answers and cover letters use it too, in a
 * separate chat (see ChatGptProjectProvider's purpose).
 */

import { preferencesSlot } from '@/storage/settings'
import { sendTabMessage } from '@/shared/utils/messaging'
import { AICancelledError, throwIfCancelled } from './retry'
import { base64ToBytes } from '@/shared/utils/bytes'
import { readLocalFile } from '@/shared/utils/local-file'
import { pickCoverLetterFile, pickResumeFile } from '@/shared/utils/pick-files'
import type { AIProvider, AIProviderId, AIProviderStatus, CompleteOptions } from '@/shared/types/ai'
import type { ChatGptFile, TabMessageMap } from '@/shared/types/messages'

/** A long resume with a reasoning model can take several minutes. */
const REPLY_TIMEOUT_MS = 8 * 60_000
const LOAD_TIMEOUT_MS = 45_000

/**
 * A usable chatgpt.com link: a chat (continued each time) or a project (a new chat
 * each time). Share links are refused - they open a read-only copy.
 */
export function parseChatGptProjectUrl(input: string): string | null {
  return checkChatGptLink(input).url ?? null
}

/** Which chat site a link is on. */
export function chatSite(url: string): 'chatgpt' | 'claude' {
  return /^https:\/\/([a-z0-9-]+\.)?claude\.ai\//i.test(url) ? 'claude' : 'chatgpt'
}

export function chatSiteName(url: string): string {
  return chatSite(url) === 'claude' ? 'Claude' : 'ChatGPT'
}

/** The link, or why it cannot be used - worded for the settings page. */
export function checkChatGptLink(input: string): { url?: string; error?: string } {
  const invalid = { error: 'Paste a chat link from chatgpt.com or claude.ai.' }
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return invalid
  }
  if (url.protocol !== 'https:' || !/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)claude\.ai$/.test(url.hostname)) {
    return invalid
  }
  if (url.pathname.startsWith('/share/')) {
    return {
      error: 'This is a Share link, which opens a read-only copy. Open the chat itself and copy the address bar instead.',
    }
  }
  url.hash = ''
  return { url: url.toString() }
}

/** A chat link (ChatGPT ".../c/<id>", Claude "/chat/<id>"): messages continue that conversation. */
export function isChatLink(url: string): boolean {
  return chatId(url) !== null
}

/** A project link (ChatGPT "/g/g-p-...", Claude "/project/<id>"): each request starts a chat in it. */
export function isProjectLink(url: string): boolean {
  return /\/g\/g-p-[^/]+/.test(url) || /claude\.ai\/project\/[0-9a-f-]{8,}/i.test(url)
}

/** One chat request at a time: they share the user's login and may share a tab. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * A chat (ChatGPT or Claude) on the user's own login, by purpose:
 * - tailor:  the tailoring chat (it holds the CV + instructions), Settings > AI;
 * - answers: the answers chat - written questions and cover letters. Never the
 *            tailoring chat, which answers every message with files.
 */
export class ChatGptProjectProvider implements AIProvider {
  readonly id: AIProviderId
  readonly label = 'Chat'
  readonly mode = 'direct' as const

  constructor(private readonly purpose: 'tailor' | 'answers' = 'tailor') {
    this.id = purpose === 'tailor' ? 'chatgpt-project' : 'chatgpt-answers'
  }

  async getStatus(): Promise<AIProviderStatus> {
    const prefs = await preferencesSlot.get()
    const link = parseChatGptProjectUrl(this.purpose === 'tailor' ? prefs.chatgptProjectUrl : prefs.chatgptAnswersUrl)
    return link
      ? { id: this.id, label: chatSiteName(link), ready: true, detail: `Your ${chatSiteName(link)} chat, in your logged-in tab` }
      : { id: this.id, label: this.label, ready: false, detail: 'Paste your chat link in Settings > AI' }
  }

  private async link(): Promise<string> {
    const prefs = await preferencesSlot.get()
    if (this.purpose === 'answers') {
      const link = parseChatGptProjectUrl(prefs.chatgptAnswersUrl)
      if (!link) throw new Error('No answers chat yet. Paste its link (ChatGPT or Claude) in Settings > AI.')
      return link
    }
    const link = parseChatGptProjectUrl(prefs.chatgptProjectUrl)
    if (!link) throw new Error('No tailoring chat yet. Paste its link (ChatGPT or Claude) in Settings > AI.')
    return link
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
    return (await this.serial(() => this.askNow(prompt, options, false))).reply
  }

  /**
   * Sends the job and returns the CV (and cover letter) the chat created. Chats
   * change how they present files, and sometimes answer without one, so:
   *   1. the files named in the answer are downloaded directly;
   *   2. otherwise the answer's own Download links are clicked and the files are
   *      collected from Chrome's downloads;
   *   3. otherwise the chat is asked once more, in the same conversation, to
   *      create both files - then 1 and 2 again.
   */
  async createFile(prompt: string, options: CompleteOptions = {}): Promise<CreatedFiles> {
    return this.serial(async () => {
      const signal = options.signal
      let answer = await this.askNow(prompt, options, true)
      let files = await this.filesOf(answer, signal)

      if (!files.resume) {
        options.onProgress?.('The chat did not attach files - asking it to create them...')
        answer = await this.askNow(MAKE_FILES_AGAIN, options, true)
        files = await this.filesOf(answer, signal)
      }
      if (!files.resume) {
        const site = chatSiteName(await this.link())
        throw new Error(`${site} did not create a CV file. It said: "${summary(answer.reply)}". Check the ${site} tab, then press Redo.`)
      }
      return { name: files.resume.name, bytes: files.resume.bytes, coverLetter: files.coverLetter }
    })
  }

  /** The CV and cover letter of one answer: named in the reply, else by clicking its Download links. */
  private async filesOf(answer: AskResult, signal?: AbortSignal): Promise<{ resume: NamedBytes | null; coverLetter: NamedBytes | null }> {
    const resume = answer.file ? await fileBytes(answer.file, signal).catch(() => null) : null
    const coverLetter = answer.coverLetter ? await fileBytes(answer.coverLetter, signal).catch(() => null) : null
    if (resume) {
      return {
        resume: { name: answer.file!.name, bytes: resume },
        coverLetter: coverLetter ? { name: answer.coverLetter!.name, bytes: coverLetter } : null,
      }
    }
    if (!answer.ref) return { resume: null, coverLetter: null }
    const downloaded = await downloadByClicking(answer.tabId, answer.ref, signal).catch(() => [])
    return { resume: pickResumeFile(downloaded), coverLetter: pickCoverLetterFile(downloaded) }
  }

  /** One request at a time, whole sequences included (they share the user's login and tabs). */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const turn = queue.then(work)
    queue = turn.catch(() => undefined)
    return turn
  }

  private async askNow(prompt: string, options: CompleteOptions, wantFile: boolean): Promise<AskResult> {
    const link = await this.link()
    const signal = options.signal
    throwIfCancelled(signal)

    // Reuse a tab already on this chat; otherwise open one, which then stays open
    // for the next request.
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = await chatTab(link)
    const onCancel = () => void sendTabMessage(tabId, 'content/chatgptStop').catch(() => undefined)
    signal?.addEventListener('abort', onCancel, { once: true })

    try {
      await waitForTab(tabId, chatSiteName(link), signal)
      const request = { prompt, timeoutMs: REPLY_TIMEOUT_MS, file: wantFile }
      let result: TabMessageMap['content/chatgptAsk']['res']
      try {
        result = await sendTabMessage(tabId, 'content/chatgptAsk', request)
      } catch (error) {
        throwIfCancelled(signal)
        // A background tab may refuse typed input; bring it forward once and retry.
        if (!/could not type|message box was not found/i.test(errorText(error))) throw error
        await chrome.tabs.update(tabId, { active: true })
        result = await sendTabMessage(tabId, 'content/chatgptAsk', request)
        if (current?.id) await chrome.tabs.update(current.id, { active: true }).catch(() => undefined)
      }
      throwIfCancelled(signal)
      options.onEvent?.({ type: 'done', model: chatSiteName(link), fallback: false })
      return { ...result, tabId }
    } catch (error) {
      if (signal?.aborted) throw new AICancelledError()
      throw new Error(`${errorText(error)} (See the ${chatSiteName(link)} tab.)`)
    } finally {
      signal?.removeEventListener('abort', onCancel)
    }
  }
}

type AskResult = TabMessageMap['content/chatgptAsk']['res'] & { tabId: number }
type NamedBytes = { name: string; bytes: Uint8Array }
export type CreatedFiles = { name: string; bytes: Uint8Array; coverLetter: NamedBytes | null }

/** The follow-up when an answer came without files. */
const MAKE_FILES_AGAIN =
  'Please create the tailored CV and the cover letter for the job above as downloadable PDF files now, and give me both download links.'

/** The reply in plain words for an error message: no markup, no Markdown, short. */
function summary(reply: string): string {
  const text = reply
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > 160 ? `${text.slice(0, 160)}...` : text
}

/**
 * Clicks the answer's Download links and collects what Chrome downloads: each
 * file is read from its download link, or from disk when the link has expired.
 */
async function downloadByClicking(tabId: number, ref: string, signal?: AbortSignal): Promise<NamedBytes[]> {
  const startedAt = Date.now()
  const created: number[] = []
  const onCreated = (item: chrome.downloads.DownloadItem) => void created.push(item.id)
  chrome.downloads.onCreated.addListener(onCreated)
  try {
    const { clicked } = await sendTabMessage(tabId, 'content/chatClickDownloads', { ref })
    if (!clicked) return []
    const deadline = Date.now() + 45_000
    let items: chrome.downloads.DownloadItem[] = []
    while (Date.now() < deadline) {
      throwIfCancelled(signal)
      const all = await chrome.downloads.search({ startedAfter: new Date(startedAt - 2_000).toISOString() })
      items = all.filter((item) => created.includes(item.id) && /\.(pdf|docx?)$/i.test(item.filename))
      const settled = items.filter((item) => item.state !== 'in_progress')
      if (items.length >= clicked && settled.length === items.length) break
      if (settled.length && Date.now() - startedAt > 15_000 && settled.length === items.length) break
      await new Promise((resolve) => setTimeout(resolve, 700))
    }

    const files: NamedBytes[] = []
    for (const item of items.filter((i) => i.state === 'complete')) {
      const name = item.filename.split(/[\\/]/).pop() ?? item.filename
      const bytes =
        (await fetchBytes(item.finalUrl || item.url).catch(() => null)) ?? (await readLocalFile(item.filename).catch(() => null))
      if (bytes) files.push({ name, bytes })
    }
    return files
  } finally {
    chrome.downloads.onCreated.removeListener(onCreated)
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  if (!/^https?:/i.test(url)) throw new Error('not a web link')
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok) throw new Error(String(response.status))
  return new Uint8Array(await response.arrayBuffer())
}

/** A created file's bytes: sent by the page, or fetched here when the page could not. */
async function fileBytes(file: ChatGptFile, signal?: AbortSignal): Promise<Uint8Array> {
  if (file.base64) return base64ToBytes(file.base64)
  if (!file.downloadUrl) throw new Error(`Could not download ${file.name} from the chat.`)
  const response = await fetch(file.downloadUrl, signal ? { signal } : {})
  if (!response.ok) throw new Error(`Could not download ${file.name} from the chat (${response.status}).`)
  return new Uint8Array(await response.arrayBuffer())
}

/** The tab this panel opened for new chats, reused while it stays open. */
let newChatTab: number | null = null

/**
 * Where new chat tabs open. Set during an unattended run to the run's window, so a
 * chat tab never appears in the window the user is working in.
 */
let chatWindowId: number | undefined

export function setChatTabWindow(windowId: number | undefined): void {
  chatWindowId = windowId
}

function createChatTab(url: string): Promise<chrome.tabs.Tab> {
  return chrome.tabs.create({ url, active: false, ...(chatWindowId !== undefined ? { windowId: chatWindowId } : {}) })
}

/** The conversation id in a chat link (ChatGPT or Claude), or null for a project / home link. */
function chatId(url: string): string | null {
  const id =
    /(?:chatgpt\.com|chat\.openai\.com)\/(?:[^?#]*\/)?c\/([0-9a-f-]{8,})/i.exec(url)?.[1] ??
    /claude\.ai\/chat\/([0-9a-f-]{8,})/i.exec(url)?.[1]
  return id?.toLowerCase() ?? null
}

/**
 * A tab for the link. Chat link: any open tab on that conversation (in any
 * window). Project link: a tab on that project, sent back to the project page so
 * each job still starts a new chat. Other ChatGPT tabs are the user's and are
 * never taken over. Nothing found: a new background tab.
 */
async function chatTab(link: string): Promise<number> {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://claude.ai/*'] })
  const id = chatId(link)

  // A new chat each time: reuse the tab opened for that before, sent back to a new chat.
  if (!id && !isProjectLink(link)) {
    const previous = newChatTab !== null ? tabs.find((tab) => tab.id === newChatTab) : undefined
    if (previous?.id !== undefined) {
      await chrome.tabs.update(previous.id, { url: link })
      await new Promise((resolve) => setTimeout(resolve, 500))
      return previous.id
    }
    const created = await createChatTab(link)
    newChatTab = created.id ?? null
    return created.id!
  }

  if (id) {
    const open = tabs.find((tab) => tab.id !== undefined && chatId(tab.url ?? tab.pendingUrl ?? '') === id)
    if (open?.id !== undefined) {
      // A tab Chrome put to sleep to save memory has to load again.
      if (open.discarded) await chrome.tabs.reload(open.id)
      return open.id
    }
  } else if (isProjectLink(link)) {
    const project = /\/g\/(g-p-[^/]+)/.exec(link)?.[1] ?? /\/project\/([0-9a-f-]+)/i.exec(link)?.[1]
    const open = tabs.find((tab) => tab.id !== undefined && project && (tab.url ?? '').includes(project))
    if (open?.id !== undefined) {
      await chrome.tabs.update(open.id, { url: link })
      // Let the navigation start, so the old page is not the one that answers.
      await new Promise((resolve) => setTimeout(resolve, 500))
      return open.id
    }
  }
  const created = await createChatTab(link)
  return created.id!
}

/** Waits for the page to load and the content script to answer. */
async function waitForTab(tabId: number, site: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  let unansweredSince = 0
  let reloaded = false
  while (Date.now() < deadline) {
    throwIfCancelled(signal)
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (!tab) throw new Error(`The ${site} tab was closed.`)
    if (tab.status === 'complete') {
      const ready = await sendTabMessage(tabId, 'content/ping').then(
        () => true,
        () => false,
      )
      if (ready) return
      // A tab opened before the extension was installed or reloaded has no
      // content script until it loads again: reload it once.
      unansweredSince ||= Date.now()
      if (!reloaded && Date.now() - unansweredSince > 2_000) {
        reloaded = true
        await chrome.tabs.reload(tabId)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${site} did not load. Check your connection and that you are logged in.`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
