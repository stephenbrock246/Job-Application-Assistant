/**
 * Thin, typed wrappers over chrome messaging.
 *
 * Everything crossing a port returns `Result<T>`; `sendMessage` unwraps it and
 * throws a normal Error on the caller's side so UI code can use try/catch.
 */

import type {
  BroadcastEvent,
  Result,
  RuntimeMessageMap,
  RuntimeMessageType,
  TabMessageMap,
  TabMessageType,
} from '../types/messages'

export class MessageError extends Error {
  code?: string
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'MessageError'
    this.code = code
  }
}

/** Side panel / content -> background. */
export async function sendMessage<T extends RuntimeMessageType>(
  type: T,
  ...args: RuntimeMessageMap[T]['req'] extends void ? [] : [RuntimeMessageMap[T]['req']]
): Promise<RuntimeMessageMap[T]['res']> {
  const payload = args[0]
  const result = (await chrome.runtime.sendMessage({ type, payload })) as
    | Result<RuntimeMessageMap[T]['res']>
    | undefined

  if (!result) {
    throw new MessageError(
      chrome.runtime.lastError?.message ?? 'No response from the background service worker.',
    )
  }
  if (!result.ok) throw new MessageError(result.error, result.code)
  return result.data
}

/** Background -> a specific tab's content script. */
export async function sendTabMessage<T extends TabMessageType>(
  tabId: number,
  type: T,
  ...args: TabMessageMap[T]['req'] extends void ? [] : [TabMessageMap[T]['req']]
): Promise<TabMessageMap[T]['res']> {
  const payload = args[0]
  const result = (await chrome.tabs.sendMessage(tabId, { type, payload })) as
    | Result<TabMessageMap[T]['res']>
    | undefined

  if (!result) throw new MessageError('The content script did not respond on this page.')
  if (!result.ok) throw new MessageError(result.error, result.code)
  return result.data
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail(error: unknown, code?: string): Result<never> {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error.'
  return code ? { ok: false, error: message, code } : { ok: false, error: message }
}

/** Background -> all open side panels. Failure is expected when no panel is open. */
export function broadcast(event: BroadcastEvent): void {
  chrome.runtime.sendMessage(event).catch(() => {
    /* no receiver - side panel is closed */
  })
}

export function onBroadcast(handler: (event: BroadcastEvent) => void): () => void {
  const listener = (message: unknown) => {
    if (message && typeof message === 'object' && 'event' in message) {
      handler(message as BroadcastEvent)
    }
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}
