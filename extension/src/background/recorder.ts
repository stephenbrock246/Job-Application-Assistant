/**
 * The black-box recorder (worker side).
 *
 *  - `log` appends to a timeline of what the extension did. Cheap: events are
 *    buffered and written in one storage write.
 *  - `recordIncident` is for when something went wrong. It saves what failed and
 *    on which job, the timeline leading up to it, the session, a screenshot of the
 *    job tab and a copy of the page, so the failure can be reproduced later.
 *
 * Recording must never break or slow the thing it records: every function here
 * swallows its own errors, and the same failure repeating on one job is counted
 * rather than captured again.
 *
 * Screenshots are only taken when the job tab is the visible tab of its window,
 * so the report never contains some other page the user had open.
 */

import { getSession } from '@/storage/sessions'
import {
  INCIDENT_LIMIT,
  LOG_LIMIT,
  flightLogSlot,
  incidentsSlot,
  removeIncidentDetails,
  setIncidentDetail,
} from '@/storage/diagnostics'
import { createId } from '@/shared/utils/format'
import { sendTabMessage } from '@/shared/utils/messaging'
import type { ApplicationSession } from '@/shared/types/application'
import type {
  IncidentDetail,
  IncidentInput,
  IncidentSummary,
  LogEvent,
  LogLevel,
  PageSnapshot,
} from '@/shared/types/diagnostics'

/** A repeat of the same failure on the same job within this window only bumps a counter. */
export const REPEAT_WINDOW_MS = 10 * 60_000
/** Events before an incident that go into it. */
const TIMELINE_LENGTH = 80
const SNAPSHOT_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// One writer: storage updates run strictly one after another.
// ---------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(work, work)
  chain = next.catch(() => undefined)
  return next
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

let pending: LogEvent[] = []
let flushing: Promise<void> | null = null

export interface LogContext {
  sessionId?: string
  url?: string
  data?: unknown
}

export function log(level: LogLevel, kind: string, message: string, context: LogContext = {}): void {
  const event: LogEvent = { at: Date.now(), level, kind, message: clip(message, 1000) }
  if (context.sessionId) event.sessionId = context.sessionId
  if (context.url) event.url = context.url
  if (context.data !== undefined) event.data = small(context.data, 4000)
  pending.push(event)
  void flushLog()
}

/** Writes buffered events. Resolves once everything logged so far is stored. */
export function flushLog(): Promise<void> {
  if (!flushing) {
    flushing = serial(async () => {
      const batch = pending
      pending = []
      if (!batch.length) return
      await flightLogSlot.update((list) => {
        const next = list.concat(batch)
        return next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next
      })
    })
      .catch(() => undefined)
      .finally(() => {
        flushing = null
        // Events logged while the write ran go in the next one.
        if (pending.length) void flushLog()
      })
  }
  return flushing
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/** Failures seen recently in this worker's lifetime, so a burst is not captured twice. */
const recent = new Map<string, { id: string; at: number }>()

/** Records a failure. Resolves with the incident id (an existing one for a repeat), or null if recording failed. */
export async function recordIncident(input: IncidentInput): Promise<string | null> {
  try {
    return await record(input)
  } catch {
    return null
  }
}

async function record(input: IncidentInput): Promise<string> {
  const now = Date.now()
  const message = clip(input.message || 'Unknown problem', 1000)
  log(input.manual ? 'warn' : 'error', input.kind, message, {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
  })

  // The same failure again on the same job: count it, do not capture it again.
  const key = `${input.sessionId ?? '-'}|${input.kind}|${message}`
  const id = createId('incident')
  if (!input.manual) {
    const seen = recent.get(key)
    if (seen && now - seen.at < REPEAT_WINDOW_MS) {
      recent.set(key, { id: seen.id, at: now })
      await countRepeat(seen.id, now)
      return seen.id
    }
    // Claimed before any await, so a simultaneous repeat counts against this one.
    recent.set(key, { id, at: now })
    const stored = (await incidentsSlot.get()).find(
      (incident) =>
        !incident.manual &&
        incident.sessionId === input.sessionId &&
        incident.kind === input.kind &&
        incident.message === message &&
        now - incident.lastAt < REPEAT_WINDOW_MS,
    )
    if (stored) {
      recent.set(key, { id: stored.id, at: now })
      await countRepeat(stored.id, now)
      return stored.id
    }
  }

  const session = input.sessionId ? await getSession(input.sessionId) : null
  const tabId = session?.tabId !== undefined && input.capture !== false ? session.tabId : undefined
  const [shot, snapshot] =
    tabId !== undefined ? await Promise.all([captureTab(tabId), snapshotTab(tabId)]) : [{ note: 'No job tab to capture.' }, null]

  await flushLog()
  const events = await flightLogSlot.get()
  const timeline = events
    .filter((event) => !input.sessionId || !event.sessionId || event.sessionId === input.sessionId)
    .slice(-TIMELINE_LENGTH)

  const summary: IncidentSummary = {
    id,
    at: now,
    lastAt: now,
    count: 1,
    kind: input.kind,
    message,
    origin: input.origin,
    hasScreenshot: Boolean(shot.dataUrl),
    hasSnapshot: Boolean(snapshot),
    ...(input.manual ? { manual: true } : {}),
    ...(input.note ? { note: clip(input.note, 2000) } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(session ? { company: session.company, position: session.position } : {}),
    ...(snapshot?.url || session?.lastPageUrl || session?.jobUrl
      ? { url: snapshot?.url ?? session?.lastPageUrl ?? session?.jobUrl }
      : {}),
    ...(snapshot?.adapter || session?.lastReport?.adapter
      ? { adapter: snapshot?.adapter ?? session?.lastReport?.adapter }
      : {}),
    ...(shot.note ? { screenshotNote: shot.note } : {}),
  }

  const detail: IncidentDetail = {
    id,
    timeline,
    ...(shot.dataUrl ? { screenshot: shot.dataUrl } : {}),
    ...(snapshot ? { snapshot } : {}),
    ...(session ? { session: trimSession(session) } : {}),
    ...(input.data !== undefined ? { data: small(input.data, 50_000) } : {}),
  }

  await serial(async () => {
    await setIncidentDetail(detail)
    const early = earlyRepeats.get(id)
    earlyRepeats.delete(id)
    if (early) Object.assign(summary, { count: summary.count + early.count, lastAt: early.lastAt })
    const list = await incidentsSlot.get()
    const next = [...list, summary]
    const dropped = next.length > INCIDENT_LIMIT ? next.splice(0, next.length - INCIDENT_LIMIT) : []
    await incidentsSlot.set(next)
    await removeIncidentDetails(dropped.map((incident) => incident.id))
  })
  return id
}

/** Repeats that arrived while their incident was still being captured, added when it is saved. */
const earlyRepeats = new Map<string, { count: number; lastAt: number }>()

function countRepeat(id: string, at: number): Promise<unknown> {
  return serial(async () => {
    const list = await incidentsSlot.get()
    if (!list.some((incident) => incident.id === id)) {
      const early = earlyRepeats.get(id)
      earlyRepeats.set(id, { count: (early?.count ?? 0) + 1, lastAt: at })
      return
    }
    await incidentsSlot.set(
      list.map((incident) => (incident.id === id ? { ...incident, count: incident.count + 1, lastAt: at } : incident)),
    )
  })
}

export async function clearDiagnostics(): Promise<void> {
  recent.clear()
  earlyRepeats.clear()
  pending = []
  await serial(async () => {
    const list = await incidentsSlot.get()
    await removeIncidentDetails(list.map((incident) => incident.id))
    await incidentsSlot.set([])
    await flightLogSlot.set([])
  })
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function captureTab(tabId: number): Promise<{ dataUrl?: string; note?: string }> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.active) return { note: 'The job tab was not the visible tab in its window.' }
    const window = await chrome.windows.get(tab.windowId)
    if (window.state === 'minimized') return { note: 'The job window was minimised.' }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 55 })
    // The user may have switched tabs while it was taken; then it shows something else.
    if (!(await chrome.tabs.get(tabId)).active) return { note: 'The tab changed while the screenshot was taken.' }
    return { dataUrl }
  } catch (error) {
    return { note: `No screenshot: ${error instanceof Error ? error.message : 'capture failed'}` }
  }
}

async function snapshotTab(tabId: number): Promise<PageSnapshot | null> {
  try {
    return await Promise.race([
      sendTabMessage(tabId, 'content/snapshot'),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS)),
    ])
  } catch {
    return null
  }
}

/** The session without the long texts (resume, cover letter, drafted answers), which say nothing about a failure. */
function trimSession(session: ApplicationSession): unknown {
  const answers = Object.fromEntries(
    Object.entries(session.answers ?? {}).map(([fieldId, answer]) => [fieldId, { ...answer, text: clip(answer.text, 300) }]),
  )
  return small(
    {
      ...session,
      resume: session.resume ? '[omitted]' : undefined,
      coverLetter: session.coverLetter
        ? { approved: session.coverLetter.approved, characters: session.coverLetter.text.length }
        : undefined,
      answers,
      jobInfo: session.jobInfo ? { ...session.jobInfo, description: clip(session.jobInfo.description, 1500) } : undefined,
    },
    200_000,
  )
}

// ---------------------------------------------------------------------------
// Crashes in the worker itself
// ---------------------------------------------------------------------------

export function installWorkerCrashHandlers(): void {
  self.addEventListener('error', (event) => {
    void recordIncident({ kind: 'worker-crash', message: event.message || 'Uncaught error', origin: 'worker', capture: false })
  })
  self.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason
    void recordIncident({
      kind: 'worker-crash',
      message: reason instanceof Error ? reason.message : String(reason),
      origin: 'worker',
      capture: false,
      ...(reason instanceof Error && reason.stack ? { data: { stack: reason.stack } } : {}),
    })
  })
}

// ---------------------------------------------------------------------------

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** A JSON-safe copy of `value`, cut down to about `maxChars` of JSON. */
export function small(value: unknown, maxChars: number): unknown {
  try {
    const json = JSON.stringify(value)
    if (json === undefined) return undefined
    return json.length > maxChars ? { truncated: `${json.slice(0, maxChars)}...` } : JSON.parse(json)
  } catch {
    return { unserialisable: String(value) }
  }
}
