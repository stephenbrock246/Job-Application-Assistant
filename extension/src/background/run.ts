/**
 * The unattended run's state and its Windows notifications (worker side).
 *
 * The panel's runner does the filling and reports each job here; this module is
 * the only writer of the run state, and it tells the user - by notification -
 * when an application is ready for approval, needs them, or was submitted.
 * Submitting itself is in the service worker (it needs the page machinery).
 */

import { runSlot } from '@/storage/run'
import { log } from './recorder'
import type { RunItem, RunState } from '@/shared/types/run'

let chain: Promise<unknown> = Promise.resolve()

/** Run-state writes, strictly one after another. */
export function updateRun(change: (state: RunState) => RunState): Promise<RunState> {
  const next = chain.then(() => runSlot.update(change))
  chain = next.catch(() => undefined)
  return next
}

export function startRun(windowId: number): Promise<RunState> {
  const now = Date.now()
  return updateRun((state) => ({
    ...state,
    mode: 'running',
    windowId,
    startedAt: now,
    heartbeatAt: now,
    status: 'Starting...',
    // A job left "working" by a run that was cut off (panel closed) is not being worked on.
    items: Object.fromEntries(
      Object.entries(state.items).map(([key, item]) => [
        key,
        item.state === 'working'
          ? { ...item, state: 'needs-help' as const, reason: 'The run stopped while this one was being filled. Check its tab.', at: now }
          : item,
      ]),
    ),
  }))
}

export async function stopRun(status?: string): Promise<void> {
  await updateRun((state) => {
    const { currentKey: _current, ...rest } = state
    return { ...rest, mode: 'idle', status: status ?? 'Stopped.' }
  })
}

export async function runProgress(status: string, currentKey?: string | null): Promise<void> {
  await updateRun((state) => {
    const next: RunState = { ...state, status, heartbeatAt: Date.now() }
    if (currentKey === null) delete next.currentKey
    else if (currentKey !== undefined) next.currentKey = currentKey
    return next
  })
}

/** Records a job's new state, and notifies the user when it now needs them (or is done). */
export async function setRunItem(item: RunItem): Promise<void> {
  let previous: RunItem | undefined
  await updateRun((state) => {
    previous = state.items[item.key]
    return { ...state, heartbeatAt: Date.now(), items: { ...state.items, [item.key]: { ...item, at: Date.now() } } }
  })
  if (previous?.state === item.state && previous.reason === item.reason) return

  log(item.state === 'needs-help' || item.state === 'check' ? 'warn' : 'info', 'run', `${item.company}: ${item.state}${item.reason ? ` - ${item.reason}` : ''}`, {
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    url: item.jobLink,
    ...(item.problems?.length ? { data: { problems: item.problems } } : {}),
  })
  await notify(item)
}

export async function dismissRunItem(key: string): Promise<void> {
  await updateRun((state) => {
    const items = { ...state.items }
    delete items[key]
    return { ...state, items }
  })
  await chrome.notifications.clear(notificationId(key)).catch(() => undefined)
}

/**
 * The user recorded (or closed) an application by hand in the main panel: a run
 * item still waiting on it - for approval, for help, for a check - is settled, so
 * the run does not wait forever on a job that is already finished.
 */
export async function settleRunItemsForSession(sessionId: string, state: 'submitted' | 'skipped', reason: string): Promise<void> {
  const waiting: RunItem['state'][] = ['ready', 'needs-help', 'check']
  const settled: string[] = []
  await updateRun((run) => {
    const items = { ...run.items }
    for (const [key, item] of Object.entries(items)) {
      if (item.sessionId !== sessionId || !waiting.includes(item.state)) continue
      const { retry: _retry, problems: _problems, ...rest } = item
      items[key] = { ...rest, state, reason, at: Date.now() }
      settled.push(key)
    }
    return settled.length ? { ...run, items } : run
  })
  await Promise.all(settled.map((key) => chrome.notifications.clear(notificationId(key)).catch(() => undefined)))
}

export async function getRunItem(key: string): Promise<RunItem | undefined> {
  return (await runSlot.get()).items[key]
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const PREFIX = 'run:'

export function notificationId(key: string): string {
  return `${PREFIX}${key}`
}

export function keyOfNotification(id: string): string | null {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : null
}

/** Buttons by item state; the click handler maps the index back with the same table. */
export const NOTIFICATION_BUTTONS: Partial<Record<RunItem['state'], ('review' | 'submit')[]>> = {
  ready: ['review', 'submit'],
  'needs-help': ['review'],
  check: ['review'],
}

async function notify(item: RunItem): Promise<void> {
  const job = item.position ? `${item.company} - ${item.position}` : item.company
  const content: { title: string; message: string; sticky: boolean } | null =
    item.state === 'ready'
      ? {
          title: `Ready to submit: ${item.company}`,
          message: `${item.position || 'Application'} is filled in and passed the safety check.${
            item.problems?.length ? ` ${item.problems.length} thing${item.problems.length === 1 ? '' : 's'} worth a look.` : ''
          }`,
          sticky: true,
        }
      : item.state === 'needs-help'
        ? { title: `Needs your help: ${item.company}`, message: item.reason ?? job, sticky: true }
        : item.state === 'check'
          ? { title: `Check: ${item.company}`, message: item.reason ?? job, sticky: true }
          : item.state === 'submitted'
            ? { title: `Submitted: ${item.company}`, message: `${item.position || 'Application'} - recorded as Applied.`, sticky: false }
            : null

  const id = notificationId(item.key)
  await chrome.notifications.clear(id).catch(() => undefined)
  if (!content) return

  const buttons = (NOTIFICATION_BUTTONS[item.state] ?? []).map((action) => ({
    title: action === 'submit' ? 'Submit' : item.state === 'ready' ? 'Review' : 'Open',
  }))
  await chrome.notifications
    .create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: content.title,
      message: content.message,
      priority: 2,
      requireInteraction: content.sticky,
      ...(buttons.length ? { buttons } : {}),
    })
    .catch(() => undefined)
}
