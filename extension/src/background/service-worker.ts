/**
 * Background service worker: the only place that talks to Google, owns tab
 * lifecycle, and mutates sessions. The side panel is a pure view over it.
 *
 * Two invariants worth stating, because the rest of the file exists to uphold them:
 *
 *  - A sheet row is never written without first confirming it still holds the job
 *    link we think it does. Rows move; a stale row number must not mark the wrong
 *    job as Applied.
 *  - "Applied" is only ever written in response to the user: pressing Done, or
 *    approving a submit that the site then visibly confirmed. A click alone is
 *    never taken as a successful submission.
 */

import { getActiveProvider } from '@/ai'
import { planAutofill } from '@/autofill/planner'
import { connect, currentAccount, disconnect } from '@/google/auth'
import { inspectSpreadsheet, readJobs } from '@/google/sheets'
import { getActiveSource } from '@/jobsource'
import { exportCsv, importCsv, markSaved } from '@/jobsource/csv/csv.source'
import { missingWritableColumns } from '@/jobsource/row-parser'
import { STATUS_TEXT } from '@/shared/constants/sheet'
import { createId, sheetDate } from '@/shared/utils/format'
import { broadcast, fail, ok, sendTabMessage } from '@/shared/utils/messaging'
import { pageUrl } from '@/shared/utils/page-compare'
import { MIN_FIRST_STEP_FIELDS, trackStep, type StepTransition } from '@/navigation/step-tracker'
import { nextEnterAction } from '@/navigation/enter-form'
import { isDifferentPosting, jobUrlKey, sameJobUrl } from '@/shared/utils/job-url'
import {
  findSessionForJob,
  findSessionForTab,
  getActiveSession,
  getSession,
  listSessions,
  patchSession,
  removeSession,
  saveSession,
  setActiveSession,
} from '@/storage/sessions'
import { preferencesSlot, queueCacheSlot, sheetConfigSlot } from '@/storage/settings'
import { answersSlot, upsertAnswer } from '@/storage/answers'
import { jobTableSlot } from '@/storage/job-table'
import { sheetLinkSlot } from '@/jobsource/sheet-link/sheet-link.source'
import { profileSlot } from '@/storage/applicant-profile'
import { CANONICAL_FIELD_BY_KEY, isAutoFillable } from '@/shared/constants/canonical-fields'
import { clearDiagnostics, installWorkerCrashHandlers, log, recordIncident } from './recorder'
import {
  NOTIFICATION_BUTTONS,
  dismissRunItem,
  getRunItem,
  keyOfNotification,
  runProgress,
  setRunItem,
  settleRunItemsForSession,
  startRun,
  stopRun,
} from './run'
import { runSlot } from '@/storage/run'
import { preSubmitCheck } from '@/shared/utils/presubmit'
import type { IncidentInput, LogLevel } from '@/shared/types/diagnostics'
import type { RunItem } from '@/shared/types/run'
import type {
  ApplicationField,
  ApplicationSession,
  AutofillReport,
  FillInstruction,
  NavigationResult,
  PageFingerprint,
  ScanResult,
  SessionStatus,
} from '@/shared/types/application'
import type {
  QueueSnapshot,
  Result,
  RuntimeEnvelope,
  TabMessageMap,
  WritingPatch,
} from '@/shared/types/messages'
import { ACTIONABLE_STATUSES, type SheetJob, type SheetJobPatch } from '@/shared/types/job'

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

installWorkerCrashHandlers()

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* older Chrome builds */
  })
})

chrome.runtime.onStartup.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  // Tab ids do not survive a browser restart, and a stale one can point at an
  // unrelated tab. Forget them; `resolveSessionTab` re-attaches by URL on demand.
  void (async () => {
    for (const session of await listSessions()) {
      if (session.tabId !== undefined) await patchSession(session.id, { tabId: undefined })
    }
  })()
})

// "Apply" on many job boards opens the application form in a new tab (SmartRecruiters
// Easy Apply, Workday, company career sites). The application follows it: the new
// tab becomes the one scanned and filled.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return
  const newTabId = tab.id
  const openerTabId = tab.openerTabId
  void (async () => {
    // Any application's tab, not only the one on screen: the unattended run works on
    // a job while the user may be looking at another.
    const session = await findSessionForTab(openerTabId)
    if (!session) return
    // Once the application form has been found, a new tab from it is a side trip - a
    // privacy policy, a "job details" link, a sign-in popup - not the application.
    // (A form opened in a new tab later can still be taken over with Continue.)
    if (session.steps?.length) return
    const updated = await patchSession(session.id, { tabId: newTabId })
    broadcast({ event: 'session/updated', session: updated })
  })().catch(() => undefined)
})

// If the tab backing the active session goes away, keep the session but forget the tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const session = await getActiveSession()
    if (session?.tabId !== tabId) return
    const updated = await patchSession(session.id, { tabId: undefined })
    broadcast({ event: 'session/updated', session: updated })
  })()
})

// A full page load in the session's tab (the user pressed Next on the page, or a
// site redirected). The content script is fresh, so re-arm it and catch up.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return
  void (async () => {
    const session = await getActiveSession()
    if (!session || navigating.has(session.id)) return
    try {
      if (session.tabId !== tabId) {
        // After a browser restart the session has no tab until one shows its page again.
        if (session.tabId !== undefined && (await tabExists(session.tabId))) return
        if ((await resolveSessionTab(session)) !== tabId) return
      }
      await followPage(session.id)
    } catch {
      /* not an injectable page (chrome://, PDF viewer...) - nothing to follow */
    }
  })()
})

// The panel follows the job you are looking at: switching to a tab, or navigating
// the current tab, to a job from your list shows *that* job's application - never
// the previous job's resume or cover letter.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => showApplicationForTab(tabId, tab.url))
    .catch(() => undefined)
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return
  void showApplicationForTab(tabId, changeInfo.url).catch(() => undefined)
})

async function showApplicationForTab(tabId: number, url: string | undefined): Promise<void> {
  const byTab = await findSessionForTab(tabId)
  const snapshot = await queueCacheSlot.get()
  // Only jobs still to act on: looking at one already applied to must not start a new application.
  const job = url
    ? snapshot?.jobs.find(
        (j) => j.jobLink && ACTIONABLE_STATUSES.includes(j.status) && sameJobUrl(j.jobLink, url),
      )
    : undefined

  // The panel's own Open button is handling this job; do not create a second session.
  if (job && opening.has(jobUrlKey(job.jobLink))) return

  // The tab now shows a job from the list that is not the one it was working on.
  if (job && !(byTab && sameJobUrl(byTab.jobUrl, job.jobLink))) {
    const session = await sessionForJob(job, tabId)
    await releaseTab(tabId, session.id)
    const saved = await saveSession(session)
    await setActiveSession(saved.id)
    broadcast({ event: 'session/updated', session: saved })

    if (!saved.jobInfo) {
      void (async () => {
        try {
          await waitForTabLoad(tabId)
          await extractJobInfo(saved.id, tabId)
        } catch {
          /* best-effort, as in openJob */
        }
      })()
    }
    return
  }

  // Back on a tab that belongs to another application: show that one.
  if (byTab) {
    const active = await getActiveSession()
    if (active?.id !== byTab.id) {
      await setActiveSession(byTab.id)
      broadcast({ event: 'session/updated', session: byTab })
    }
  }
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

type Handler = (payload: never, sender: chrome.runtime.MessageSender) => Promise<unknown>

/** The session fields the panel may write directly. Everything else is worker-owned. */
const WRITING_KEYS = [
  'resume',
  'coverLetter',
  'answers',
  'pendingAi',
  'tailoredResume',
  'resumeApproved',
  'autopilot',
] as const satisfies readonly (keyof ApplicationSession)[]

const handlers: Record<string, Handler> = {
  'auth/status': async () => currentAccount(),

  'auth/connect': async () => {
    const account = await connect()
    broadcast({ event: 'auth/updated', account })
    return account
  },

  'auth/disconnect': async () => {
    await disconnect()
    await queueCacheSlot.clear()
    broadcast({ event: 'auth/updated', account: null })
    return null
  },

  'sheets/inspect': async ({ spreadsheetId }: { spreadsheetId: string }) =>
    inspectSpreadsheet(spreadsheetId),

  'sheets/connect': async (payload: {
    spreadsheetId: string
    sheetName: string
    headerRow: number
  }) => {
    const { spreadsheetId, sheetName, headerRow } = payload
    const info = await inspectSpreadsheet(spreadsheetId)
    // readJobs throws a descriptive error if required headers are missing.
    const { headers, columnMap } = await readJobs(spreadsheetId, sheetName, headerRow)

    await sheetConfigSlot.set({
      spreadsheetId,
      sheetName,
      headerRow,
      spreadsheetTitle: info.spreadsheetTitle,
      columnMap,
      detectedHeaders: headers,
    })
    await queueCacheSlot.clear()

    const snapshot = await refreshQueue()
    broadcast({ event: 'queue/updated', snapshot })

    return {
      detectedHeaders: headers,
      missing: missingWritableColumns(columnMap).map(String),
    }
  },

  'source/status': async () => {
    const source = await getActiveSource()
    return source.getStatus()
  },

  'source/queue': async (payload: { force?: boolean } | undefined) => {
    if (!payload?.force) {
      const cached = await queueCacheSlot.get()
      if (cached && Date.now() - cached.fetchedAt < 15_000) return cached
    }
    const snapshot = await refreshQueue()
    broadcast({ event: 'queue/updated', snapshot })
    return snapshot
  },

  'source/updateRow': async (payload: { rowNumber: number; patch: SheetJobPatch }) => {
    const source = await getActiveSource()
    await source.updateRow(payload.rowNumber, payload.patch)
    const snapshot = await refreshQueue()
    broadcast({ event: 'queue/updated', snapshot })
    return null
  },

  'csv/import': async (payload: {
    fileName: string
    text: string
    addMissingColumns: boolean
    hasFileHandle: boolean
  }) => {
    const result = await importCsv(payload)
    await queueCacheSlot.clear()

    const snapshot = await refreshQueue()
    broadcast({ event: 'queue/updated', snapshot })
    broadcast({ event: 'source/updated', status: await (await getActiveSource()).getStatus() })

    return result
  },

  'csv/export': async () => exportCsv(),

  'csv/markSaved': async ({ hasFileHandle }: { hasFileHandle: boolean }) => {
    await markSaved(hasFileHandle)
    broadcast({ event: 'source/updated', status: await (await getActiveSource()).getStatus() })
    return null
  },

  'job/open': async ({ jobId, windowId }: { jobId: string; windowId?: number }) => openJob(jobId, windowId),

  'job/markDone': async ({ sessionId, notes }: { sessionId: string; notes?: string }) =>
    finishSession(sessionId, 'APPLIED', notes),

  'job/markFailed': async (payload: { sessionId: string; reason: string; notes?: string }) => {
    const note = [payload.reason, payload.notes].filter(Boolean).join(' - ')
    return finishSession(payload.sessionId, 'FAILED', note)
  },

  'job/abandon': async ({ sessionId }: { sessionId: string }) => {
    await removeSession(sessionId)
    await settleRunItemsForSession(sessionId, 'skipped', 'Closed by you without recording.')
    broadcast({ event: 'session/updated', session: null })
    return null
  },

  'job/focusTab': async ({ sessionId }: { sessionId: string }) => {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')

    const attached = await resolveSessionTab(session)
    if (attached !== undefined) {
      await chrome.tabs.update(attached, { active: true })
      const tab = await chrome.tabs.get(attached)
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
      return null
    }

    // Reopen where the application was, not at the posting. Sites that cannot
    // restore a mid-flow page show their first step, which the step tracker
    // recognises as a return rather than a new step.
    const tab = await chrome.tabs.create({ url: session.lastPageUrl ?? session.jobUrl, active: true })
    const updated = await patchSession(session.id, { tabId: tab.id })
    broadcast({ event: 'session/updated', session: updated })
    return null
  },

  'session/active': async () => getActiveSession(),

  // What the user types beats what was scraped: a company the page never names, a
  // cleaner position title, or the real job description when extraction grabbed
  // the wrong block. A pasted description is trusted (confidence 1), and an
  // autopilot step that stopped only because the old one looked unreliable runs again.
  'session/updateJob': async (payload: {
    sessionId: string
    company?: string
    position?: string
    description?: string
  }) => {
    const session = await getSession(payload.sessionId)
    if (!session) throw new Error('That application session no longer exists.')

    const patch: Partial<ApplicationSession> = {}
    if (payload.company !== undefined) patch.company = payload.company.trim()
    if (payload.position !== undefined) patch.position = payload.position.trim()

    const description = payload.description?.trim()
    if (description) {
      patch.jobInfo = {
        ...(session.jobInfo ?? { title: session.position, company: session.company, location: '' }),
        description,
        source: 'pasted by you',
        confidence: 1,
        extractedAt: Date.now(),
      }
      const stopped = session.autopilot?.resume
      if (stopped && stopped.state !== 'running' && stopped.state !== 'done' && !session.resume) {
        const next = { ...session.autopilot }
        delete next.resume
        patch.autopilot = next
      }
    }

    const updated = await patchSession(session.id, patch)
    broadcast({ event: 'session/updated', session: updated })
    return updated
  },

  // Resume / cover letter / drafted answers are produced in the side panel (the
  // .docx work needs a DOM); the worker stays the only writer of sessions.
  'session/updateWriting': async ({ sessionId, patch }: { sessionId: string; patch: WritingPatch }) => {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')

    const next: Record<string, unknown> = {}
    for (const key of WRITING_KEYS) {
      if (!(key in patch)) continue
      const value = (patch as Record<string, unknown>)[key]
      if (key === 'answers' || key === 'pendingAi') {
        const merged: Record<string, unknown> = { ...(session[key] ?? {}) }
        for (const [entry, entryValue] of Object.entries((value ?? {}) as Record<string, unknown>)) {
          if (entryValue === null) delete merged[entry]
          else merged[entry] = entryValue
        }
        next[key] = merged
      } else {
        next[key] = value === null ? undefined : value
      }
    }

    const updated = await patchSession(sessionId, next as Partial<ApplicationSession>)
    broadcast({ event: 'session/updated', session: updated })
    return updated
  },

  'session/refreshJobInfo': async ({ sessionId }: { sessionId: string }) => {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    if (session.tabId === undefined) {
      throw new Error('The job tab is closed. Use "Open in new tab" first.')
    }
    const updated = await extractJobInfo(session.id, session.tabId)
    return updated ?? session
  },

  'page/scan': async ({ sessionId, auto }: { sessionId: string; auto?: boolean }) => {
    if (!auto) await adoptViewedTab(sessionId)
    return (await runPagePass(sessionId, 'scan')).report
  },

  'page/autofill': async ({ sessionId, auto }: { sessionId: string; auto?: boolean }) => {
    if (!auto) await adoptViewedTab(sessionId)
    return (await runPagePass(sessionId, 'autofill')).report
  },

  'page/enterForm': async ({ sessionId }: { sessionId: string }) => enterForm(sessionId),

  // Continue after the user opened the form themselves: carry on in the tab they are looking at.
  'job/adoptViewedTab': async ({ sessionId }: { sessionId: string }) => {
    await adoptViewedTab(sessionId)
    return null
  },

  'page/next': async ({ sessionId, force }: { sessionId: string; force?: boolean }) => {
    if (navigating.has(sessionId)) throw new Error('Already moving to the next page.')
    navigating.add(sessionId)
    cancelledNext.delete(sessionId)
    try {
      return await navigateNext(sessionId, force ?? false)
    } finally {
      navigating.delete(sessionId)
      cancelledNext.delete(sessionId)
    }
  },

  'page/cancelNext': async ({ sessionId }: { sessionId: string }) => {
    if (!navigating.has(sessionId)) return null
    cancelledNext.add(sessionId)
    // Also end the page-side wait at once, rather than at its 15s deadline.
    const session = await getSession(sessionId)
    if (session?.tabId !== undefined) {
      await sendTabMessage(session.tabId, 'content/cancelWait').catch(() => null)
    }
    return null
  },

  'page/observed': async (_payload: unknown, sender: chrome.runtime.MessageSender) => {
    const session = await getActiveSession()
    const tabId = sender.tab?.id
    // Only the session's own tab is followed; every other page is ignored.
    if (!session || tabId === undefined || session.tabId !== tabId) return null
    if (navigating.has(session.id)) return null
    await followPage(session.id)
    return null
  },

  'page/answerField': async (payload: {
    sessionId: string
    fieldId: string
    value: string
    saveAsDefault: boolean
    canonicalField?: string
    label: string
  }) => {
    const session = await getSession(payload.sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    const tabId = await requireSessionTab(session)

    if (payload.saveAsDefault) {
      const key = payload.canonicalField
      const def = key ? CANONICAL_FIELD_BY_KEY.get(key) : undefined
      // Only a mapped, auto-fillable field can become a reusable default. A legal
      // attestation or demographic answer is never saved, whatever the UI asked for.
      if (!key || !def || !isAutoFillable(def.category)) {
        throw new Error('This answer cannot be saved as a default - it is not a reusable field.')
      }
      await upsertAnswer({
        key,
        label: def.label,
        value: payload.value,
        autoFill: true,
        category: def.category,
      })
    }

    // A site-built control has to be operated (clicked), not written - carry its kind.
    const widget = session.lastReport?.fields?.find((field) => field.id === payload.fieldId)?.widget
    const instruction: FillInstruction = {
      fieldId: payload.fieldId,
      value: payload.value,
      source: 'user',
      ...(payload.canonicalField ? { canonicalField: payload.canonicalField } : {}),
      ...(widget ? { widget } : {}),
    }
    await sendTabMessage(tabId, 'content/fillFields', { instructions: [instruction] })

    // Re-scan so the panel reflects the page as it actually is after the write.
    return (await runPagePass(payload.sessionId, 'scan')).report
  },

  'page/attachFile': async (payload: {
    sessionId: string
    fieldId: string
    fileName: string
    mime: string
    base64: string
  }) => {
    const session = await getSession(payload.sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    const tabId = await requireSessionTab(session)
    await ensureContentScript(tabId)

    const { sessionId, ...file } = payload
    const outcome = await sendTabMessage(tabId, 'content/attachFile', file)
    // Rescan so the report shows the field as filled (or still empty) as it really is.
    await runPagePass(sessionId, 'scan').catch(() => null)
    return outcome
  },

  // An application form embedded from another site: open it in the job tab itself,
  // where it can be scanned and filled like any other page.
  'page/openEmbedded': async ({ sessionId, url }: { sessionId: string; url: string }) => {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    if (!/^https?:\/\//i.test(url)) throw new Error('That is not a web address.')
    const tabId = await requireSessionTab(session)
    await chrome.tabs.update(tabId, { url, active: true })
    return null
  },

  'page/highlightField': async ({ sessionId, fieldId }: { sessionId: string; fieldId: string }) => {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    const tabId = await requireSessionTab(session)

    await chrome.tabs.update(tabId, { active: true })
    const tab = await chrome.tabs.get(tabId)
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })

    await sendTabMessage(tabId, 'content/highlightField', { fieldId })
    return null
  },

  'ai/status': async () => {
    const provider = await getActiveProvider()
    return provider.getStatus()
  },

  'diag/report': async (input: IncidentInput) => ({ incidentId: await recordIncident(input) }),

  'diag/log': async (payload: { level: LogLevel; kind: string; message: string; sessionId?: string; data?: unknown }) => {
    log(payload.level, payload.kind, payload.message, {
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      ...(payload.data !== undefined ? { data: payload.data } : {}),
    })
    return null
  },

  'diag/clear': async () => {
    await clearDiagnostics()
    return null
  },

  'run/start': async ({ windowId }: { windowId: number }) => {
    // One run at a time: a live run in another window (recent heartbeat) is not taken over.
    const run = await runSlot.get()
    if (run.mode === 'running' && run.windowId !== windowId && Date.now() - (run.heartbeatAt ?? 0) < 60_000) {
      throw new Error('Autopilot is already running in another window. Stop it there first.')
    }
    return startRun(windowId)
  },

  'run/stop': async (payload: { status?: string } | undefined) => {
    await stopRun(payload?.status)
    return null
  },

  'run/progress': async ({ status, currentKey }: { status: string; currentKey?: string | null }) => {
    await runProgress(status, currentKey)
    return null
  },

  'run/item': async (item: RunItem) => {
    await setRunItem(item)
    return null
  },

  'run/approve': async ({ key }: { key: string }) => {
    await approveSubmit(key)
    return null
  },

  'run/review': async ({ key }: { key: string }) => {
    await reviewRunItem(key)
    return null
  },

  'run/dismiss': async ({ key }: { key: string }) => {
    await dismissRunItem(key)
    return null
  },
}

/** Failed requests worth a problem report: anything acting on a job, its page or the job list. */
function recordsFailure(type: string, error: unknown): boolean {
  if (!/^(page|job|session|source|csv)\//.test(type)) return false
  // A second press while the first is still running is not a failure.
  return !(error instanceof Error && error.message === 'Already moving to the next page.')
}

function sessionIdOf(payload: unknown): string | undefined {
  const id = (payload as { sessionId?: unknown } | null | undefined)?.sessionId
  return typeof id === 'string' ? id : undefined
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRuntimeEnvelope(message)) return false

  const handler = handlers[message.type]
  if (!handler) {
    sendResponse(fail(`Unknown message type: ${message.type}`, 'UNKNOWN_MESSAGE'))
    return false
  }

  // Async response: must return true synchronously to keep the port open.
  void (async () => {
    try {
      const data = await (
        handler as (p: unknown, s: chrome.runtime.MessageSender) => Promise<unknown>
      )(message.payload, sender)
      sendResponse(ok(data) as Result<unknown>)
    } catch (error) {
      const code = (error as { code?: string }).code
      sendResponse(fail(error, code))
      if (recordsFailure(message.type, error)) {
        const sessionId = sessionIdOf(message.payload)
        void recordIncident({
          kind: 'action-failed',
          message: error instanceof Error ? error.message : String(error),
          origin: message.type,
          ...(sessionId ? { sessionId } : {}),
          ...(code || (error instanceof Error && error.stack)
            ? { data: { ...(code ? { code } : {}), ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) } }
            : {}),
        })
      }
    }
  })()

  return true
})

function isRuntimeEnvelope(message: unknown): message is RuntimeEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof (message as { type: unknown }).type === 'string' &&
    !(message as { type: string }).type.startsWith('content/')
  )
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function refreshQueue(): Promise<QueueSnapshot> {
  const source = await getActiveSource()
  const { jobs } = await source.readJobs()

  const snapshot: QueueSnapshot = {
    jobs,
    counts: countByStatus(jobs),
    fetchedAt: Date.now(),
  }
  await queueCacheSlot.set(snapshot)
  return snapshot
}

function countByStatus(jobs: SheetJob[]): QueueSnapshot['counts'] {
  const counts = { ready: 0, inProgress: 0, applied: 0, failed: 0, other: 0, total: jobs.length }
  for (const job of jobs) {
    switch (job.status) {
      case 'READY':
        counts.ready += 1
        break
      case 'IN_PROGRESS':
        counts.inProgress += 1
        break
      case 'APPLIED':
        counts.applied += 1
        break
      case 'FAILED':
        counts.failed += 1
        break
      default:
        counts.other += 1
    }
  }
  return counts
}

// ---------------------------------------------------------------------------
// Job lifecycle
// ---------------------------------------------------------------------------

/** Job links being opened from the panel right now; the tab listener leaves them to openJob. */
const opening = new Set<string>()

/**
 * The session for a job: its existing one (same link, possibly moved to another
 * row), refreshed from the list - or a brand-new, empty one. A new job never
 * inherits another job's resume, cover letter or answers.
 */
async function sessionForJob(job: SheetJob, tabId: number | undefined): Promise<ApplicationSession> {
  const scope = await sourceScope()
  const existing = await findSessionForJob(scope.spreadsheetId, scope.sheetName, job.jobLink)
  if (existing) {
    return {
      ...existing,
      tabId,
      sheetRow: job.rowNumber,
      jobUrl: job.jobLink,
      company: job.company || existing.company,
      position: job.position || existing.position,
    }
  }
  return {
    id: createId('session'),
    sheetRow: job.rowNumber,
    spreadsheetId: scope.spreadsheetId,
    sheetName: scope.sheetName,
    jobUrl: job.jobLink,
    company: job.company,
    position: job.position,
    currentStep: 1,
    totalStepsSeen: 1,
    completedFields: {},
    unansweredFields: [],
    status: 'ANALYZING',
    tabId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** A tab works on one application at a time: any other session holding it lets go. */
async function releaseTab(tabId: number | undefined, keepSessionId: string): Promise<void> {
  if (tabId === undefined) return
  for (const session of await listSessions()) {
    if (session.tabId === tabId && session.id !== keepSessionId) {
      await patchSession(session.id, { tabId: undefined })
    }
  }
}

async function openJob(jobId: string, windowId?: number): Promise<ApplicationSession> {
  const source = await getActiveSource()
  const snapshot = (await queueCacheSlot.get()) ?? (await refreshQueue())
  const job = snapshot.jobs.find((j) => j.id === jobId)
  if (!job) throw new Error('That job is no longer in the list. Refresh the queue and try again.')
  if (!job.jobLink) throw new Error('This row has no Job Link, so there is nothing to open.')

  const linkKey = jobUrlKey(job.jobLink)
  opening.add(linkKey)
  try {
    return await openJobSession(job, source, windowId)
  } finally {
    opening.delete(linkKey)
  }
}

async function openJobSession(
  job: SheetJob,
  source: Awaited<ReturnType<typeof getActiveSource>>,
  windowId?: number,
): Promise<ApplicationSession> {
  const scope = await sourceScope()
  const prefs = await preferencesSlot.get()

  // Resume this job's own session (matched by its link) rather than starting a second one.
  const existing = await findSessionForJob(scope.spreadsheetId, scope.sheetName, job.jobLink)

  if (prefs.markInProgressOnOpen && job.status === 'READY') {
    // A source without a Status column simply cannot record this; that is not a
    // reason to refuse to open the job.
    await source
      .updateRow(job.rowNumber, { status: STATUS_TEXT.IN_PROGRESS })
      .catch(() => undefined)
  }

  // Resuming a session goes back to the application page it reached, not the posting.
  const tab = await openJobTab(
    existing?.lastPageUrl ?? job.jobLink,
    prefs.openJobsInNewTab,
    existing?.tabId,
    windowId,
  )

  const session = await sessionForJob(job, tab.id)
  await releaseTab(tab.id, session.id)

  const saved = await saveSession(session)
  await setActiveSession(saved.id)
  broadcast({ event: 'session/updated', session: saved })
  log('info', 'job-opened', `${job.company || 'Unknown company'} - ${job.position || 'unknown position'} (row ${job.rowNumber})`, {
    sessionId: saved.id,
    url: job.jobLink,
    data: { resumed: Boolean(existing) },
  })

  // The job is open: a list that cannot be re-read right now (Google busy) must not undo that.
  try {
    broadcast({ event: 'queue/updated', snapshot: await refreshQueue() })
  } catch (error) {
    log('warn', 'job-list', `Could not refresh the job list after opening: ${error instanceof Error ? error.message : String(error)}`, {
      sessionId: saved.id,
    })
  }

  // Extraction happens after the tab settles; the panel updates via broadcast.
  if (tab.id !== undefined) {
    void (async () => {
      try {
        await waitForTabLoad(tab.id!)
        await extractJobInfo(saved.id, tab.id!)
      } catch (error) {
        // Best-effort; the panel shows "not extracted". Kept in the timeline for reports.
        log('warn', 'job-description', `Could not read the job posting: ${error instanceof Error ? error.message : String(error)}`, {
          sessionId: saved.id,
        })
      }
    })()
  }

  return saved
}

/**
 * windowId (the unattended run): the tab opens in that window, as its visible tab,
 * without focusing the window - the user keeps working wherever they are.
 */
async function openJobTab(
  url: string,
  preferNewTab: boolean,
  existingTabId: number | undefined,
  windowId?: number,
): Promise<chrome.tabs.Tab> {
  if (existingTabId !== undefined && (await tabExists(existingTabId))) {
    const existing = await chrome.tabs.get(existingTabId)
    if (windowId === undefined || existing.windowId === windowId) {
      return (await chrome.tabs.update(existingTabId, { url, active: true })) as chrome.tabs.Tab
    }
  }
  if (windowId !== undefined) return chrome.tabs.create({ url, windowId, active: true })
  if (preferNewTab) return chrome.tabs.create({ url, active: true })

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active?.id !== undefined) {
    return (await chrome.tabs.update(active.id, { url })) as chrome.tabs.Tab
  }
  return chrome.tabs.create({ url, active: true })
}

/**
 * Marks a session finished and writes the outcome to the sheet.
 * Only ever called from an explicit user action (Done or Skip/Failed).
 */
async function finishSession(
  sessionId: string,
  outcome: 'APPLIED' | 'FAILED',
  notes?: string,
): Promise<null> {
  const session = await getSession(sessionId)
  if (!session) throw new Error('That application session no longer exists.')

  const source = await getActiveSource()

  const stillCorrectRow = await source.verifyRow(session.sheetRow, session.jobUrl)
  if (!stillCorrectRow) {
    throw new Error(
      `Row ${session.sheetRow} no longer contains this job's link - the job list may have changed. ` +
        'Refresh the queue and update that row manually so nothing is marked incorrectly.',
    )
  }

  const patch =
    outcome === 'APPLIED'
      ? {
          status: STATUS_TEXT.APPLIED,
          appliedDate: sheetDate(),
          ...(session.tailoredResume ? { resume: session.tailoredResume } : {}),
          ...(notes ? { other: notes } : {}),
        }
      : {
          status: STATUS_TEXT.FAILED,
          ...(notes ? { other: notes } : {}),
        }

  await source.updateRow(session.sheetRow, patch)
  log('info', 'job-finished', `${outcome}${notes ? ` - ${notes}` : ''}`, { sessionId: session.id, url: session.lastPageUrl ?? session.jobUrl })

  await removeSession(session.id)
  await settleRunItemsForSession(
    session.id,
    outcome === 'APPLIED' ? 'submitted' : 'skipped',
    outcome === 'APPLIED' ? 'Recorded as Applied.' : `Recorded as not applied${notes ? `: ${notes}` : '.'}`,
  )
  broadcast({ event: 'session/updated', session: null })

  // The outcome is recorded; a list that cannot be re-read this second refreshes later.
  try {
    broadcast({ event: 'queue/updated', snapshot: await refreshQueue() })
  } catch (error) {
    log('warn', 'job-list', `Could not refresh the job list after recording: ${error instanceof Error ? error.message : String(error)}`)
  }
  broadcast({ event: 'source/updated', status: await source.getStatus() })

  return null
}

/**
 * Namespace used to tie a session to its row.
 *
 * Sessions predate the source abstraction and store `spreadsheetId` / `sheetName`;
 * for a CSV those become the file name, which serves the same purpose - telling
 * two different job lists apart.
 */
async function sourceScope(): Promise<{ spreadsheetId: string; sheetName: string }> {
  const prefs = await preferencesSlot.get()
  if (prefs.jobSourceId === 'csv') {
    const table = await jobTableSlot.get()
    return { spreadsheetId: 'csv', sheetName: table?.fileName ?? 'unknown.csv' }
  }
  if (prefs.jobSourceId === 'sheet-link') {
    const link = await sheetLinkSlot.get()
    return { spreadsheetId: link?.spreadsheetId ?? '', sheetName: `gid:${link?.gid ?? '0'}` }
  }
  const config = await sheetConfigSlot.get()
  return {
    spreadsheetId: config?.spreadsheetId ?? '',
    sheetName: config?.sheetName ?? '',
  }
}

// ---------------------------------------------------------------------------
// Application page pass (phases 3 + 4)
// ---------------------------------------------------------------------------

/**
 * - scan:     dry run. Produces the full report without writing anything.
 * - autofill: fill everything the planner allows, then verify.
 * - follow:   the page changed under us. Scan, and autofill only if this is a step
 *             we have never seen (and the user left "autofill new pages" on).
 */
type PassMode = 'scan' | 'autofill' | 'follow'

interface PassResult {
  report: AutofillReport
  /** Fields as they stand after the pass - the source of truth for "still empty". */
  fields: ApplicationField[]
  transition: StepTransition
  session: ApplicationSession
}

/** Sessions with a pass running. Page-change notifications during a pass are dropped. */
const passing = new Set<string>()
/** Sessions with a Next in flight. Everything else stands aside until it resolves. */
const navigating = new Set<string>()
/** Next requests the user cancelled; checked between the steps of navigateNext. */
const cancelledNext = new Set<string>()

/**
 * Scan the page, decide what can be filled, optionally fill it, verify, and
 * record which step of the application this page is.
 */
/** Per session, the pass running now (and any queued behind it). */
const passQueues = new Map<string, Promise<unknown>>()

/**
 * Passes on one session run one after another: two at once (a page-change follow
 * and the runner's Autofill) would operate the same dropdowns together and the
 * second report would overwrite the first.
 */
async function runPagePass(sessionId: string, mode: PassMode): Promise<PassResult> {
  const previous = passQueues.get(sessionId) ?? Promise.resolve()
  const mine = previous.catch(() => undefined).then(() => pagePass(sessionId, mode))
  const tail = mine.catch(() => undefined)
  passQueues.set(sessionId, tail)
  passing.add(sessionId)
  try {
    return await mine
  } finally {
    if (passQueues.get(sessionId) === tail) {
      passQueues.delete(sessionId)
      passing.delete(sessionId)
    }
  }
}

async function pagePass(sessionId: string, mode: PassMode): Promise<PassResult> {
  const session = await getSession(sessionId)
  if (!session) throw new Error('That application session no longer exists.')

  const tabId = await requireSessionTab(session)
  await ensureContentScript(tabId)
  // Idempotent: keeps the page watcher armed across full page loads.
  await sendTabMessage(tabId, 'content/watch', { enabled: true }).catch(() => null)

  const scan = await sendTabMessage(tabId, 'content/scanFields')
  const [profile, savedAnswers, prefs] = await Promise.all([
    profileSlot.get(),
    answersSlot.get(),
    preferencesSlot.get(),
  ])
  const plan = planAutofill(scan.fields, profile, savedAnswers)

  const preliminary = trackStep(session, scan.page, countFields(scan.fields))
  const autofill =
    mode === 'autofill' ||
    (mode === 'follow' && preliminary.transition === 'advanced' && prefs.autofillOnNewPage)

  let filled: AutofillReport['filled'] = []
  if (autofill && plan.instructions.length) {
    filled = await sendTabMessage(tabId, 'content/fillFields', { instructions: plan.instructions })
  }

  // Read the page back after writing, so "filled" reflects the DOM and not our intent.
  const validationErrors = await sendTabMessage(tabId, 'content/detectErrors').catch(() => [])
  const verified = autofill ? await sendTabMessage(tabId, 'content/scanFields') : scan
  // A fill can reveal conditional questions, so plan again against what is there now.
  const finalPlan = autofill ? planAutofill(verified.fields, profile, savedAnswers) : plan

  // A field we tried to fill but which came back empty is unresolved, not done.
  const valueNow = new Map(verified.fields.map((field) => [field.id, field.value ?? '']))
  const failedFills = filled.filter((outcome) => !outcome.filled || !valueNow.get(outcome.fieldId))
  const askedIds = new Set(finalPlan.ask.map((p) => p.field.id))

  const ask = [
    ...finalPlan.ask,
    ...failedFills
      .map((outcome) => plan.plans.find((p) => p.field.id === outcome.fieldId))
      .filter((p): p is NonNullable<typeof p> => Boolean(p) && !askedIds.has(p!.field.id))
      .map((p) => ({
        ...p,
        decision: 'ask' as const,
        reasonCode: 'NEEDS_USER' as const,
        reason: 'The page did not accept the value we wrote. Please set it manually.',
      })),
  ]

  if (failedFills.length) {
    // The page refused (or silently cleared) a value: the most common sign that a
    // site's controls need site-specific handling.
    const rejected = failedFills.map((outcome) => {
      const planned = plan.plans.find((p) => p.field.id === outcome.fieldId)
      return {
        label: planned?.field.label ?? outcome.fieldId,
        type: planned?.field.type,
        widget: planned?.field.widget,
        tried: planned?.value,
        pageNow: valueNow.get(outcome.fieldId) ?? null,
        error: outcome.error,
      }
    })
    void recordIncident({
      kind: 'fill-rejected',
      message: `The page did not keep the value for: ${rejected.map((r) => r.label).join(', ')}`,
      origin: `pass:${mode}`,
      sessionId,
      data: { url: verified.url, adapter: verified.adapter, rejected },
    })
  }

  const step = trackStep(session, verified.page, countFields(verified.fields))

  // A dry scan of the same step keeps the list of what the last autofill wrote.
  const filledNow = filled.filter((outcome) => outcome.filled)
  const carried =
    !autofill && step.transition === 'same'
      ? (session.lastReport?.filled ?? []).filter((outcome) => valueNow.has(outcome.fieldId))
      : []

  const report: AutofillReport = {
    scannedAt: Date.now(),
    url: verified.url,
    adapter: verified.adapter,
    totalFields: verified.fields.length,
    requiredFields: verified.fields.filter((field) => field.required).length,
    completedFields: verified.fields.filter((field) => Boolean(field.value)).length,
    // A control whose value cannot be read is "check on the page", not "empty".
    outstandingRequired: verified.fields.filter((field) => field.required && !field.value && !field.valueUnknown).length,
    filled: autofill ? filledNow : carried,
    ask,
    skipped: finalPlan.skipped,
    validationErrors,
    nextButtonLabel: verified.nextButtonLabel,
    nextButtonKind: verified.nextButtonKind,
    fields: verified.fields,
    embeddedForms: verified.embeddedForms,
  }

  const completedFields = { ...session.completedFields }
  for (const outcome of filledNow) {
    const source = plan.plans.find((p) => p.field.id === outcome.fieldId)
    if (source?.field.canonicalField) {
      completedFields[source.field.canonicalField] = outcome.actualValue ?? source.value
    }
  }

  const moved = step.transition === 'advanced' || step.transition === 'returned'

  const updated = await patchSession(sessionId, {
    lastReport: report,
    completedFields,
    unansweredFields: ask.map((p) => p.field),
    status: deriveStatus(ask.length, verified, step.steps.length),
    currentStep: step.currentStep,
    totalStepsSeen: step.totalStepsSeen,
    steps: step.steps,
    ...(step.currentPage ? { currentPage: step.currentPage } : {}),
    ...(step.transition !== 'none' ? { lastPageUrl: verified.url } : {}),
    confirmationDetected: verified.confirmationDetected,
    // A Next result describes the page it was issued from; once we are elsewhere it is stale.
    ...(moved && mode === 'follow' ? { lastNavigation: undefined } : {}),
  })
  if (!updated) throw new Error('That application session no longer exists.')
  broadcast({ event: 'session/updated', session: updated })

  log(
    'info',
    'page-pass',
    `${mode} step ${step.currentStep} (${step.transition}): ${report.totalFields} fields, filled ${filledNow.length}, ${ask.length} need input, ${validationErrors.length} page errors`,
    {
      sessionId,
      url: verified.url,
      data: {
        adapter: verified.adapter,
        next: verified.nextButtonLabel,
        ask: ask.map((p) => ({ label: p.field.label, reason: p.reasonCode })),
        errors: validationErrors.map((e) => e.message),
      },
    },
  )

  return { report, fields: verified.fields, transition: step.transition, session: updated }
}

function countFields(fields: ApplicationField[]): { totalFields: number; completedFields: number } {
  return {
    totalFields: fields.length,
    completedFields: fields.filter((field) => Boolean(field.value)).length,
  }
}

function deriveStatus(askCount: number, scan: ScanResult, stepCount: number): SessionStatus {
  if (askCount) return 'NEEDS_INPUT'
  // Only a final submit is left: the user reviews and submits. We never do.
  // (On a posting page, "Apply" is just the way into the form.)
  if (scan.nextButtonKind === 'submit' && stepCount > 0) return 'REVIEW'
  if (scan.confirmationDetected) return 'REVIEW'
  // A later step with no questions and no way forward is a summary page.
  if (!scan.nextButtonKind && !scan.fields.length && stepCount > 1) return 'REVIEW'
  return 'APPLYING'
}

/**
 * Catch up with a page change the extension did not cause - the user clicked
 * through the form themselves, or the site moved on its own.
 */
async function followPage(sessionId: string): Promise<void> {
  if (passing.has(sessionId) || navigating.has(sessionId)) return

  const session = await getSession(sessionId)
  if (!session) return

  // Until an application form appears, only keep the watcher armed. A job posting
  // is not a step, and scanning it would replace the session's report with noise.
  if (!session.currentPage) {
    const tabId = await requireSessionTab(session)
    await ensureContentScript(tabId)
    await sendTabMessage(tabId, 'content/watch', { enabled: true })
    const { page } = await sendTabMessage(tabId, 'content/pageState')
    if (page.fieldKeys.length < MIN_FIRST_STEP_FIELDS) return
  }

  await runPagePass(sessionId, 'follow')
}

// ---------------------------------------------------------------------------
// Next / Continue (phase 4, spec section 18)
// ---------------------------------------------------------------------------

/** How long a click gets to produce a visible change before we call it stuck. */
const NAVIGATION_TIMEOUT_MS = 15_000

/**
 * click -> wait -> did the page change? -> errors? -> correct once -> retry.
 *
 * Nothing here treats a click as progress. Only an observed page change moves the
 * session forward, and a final submit control is never clicked at all.
 */
async function navigateNext(sessionId: string, force: boolean): Promise<NavigationResult> {
  // 1. Finish this page: fill what can safely be filled, then see what is still empty.
  const before = await runPagePass(sessionId, 'autofill')
  const tabId = await requireSessionTab(before.session)
  const fromStep = before.session.currentStep

  const cancelled = (clicked: boolean) =>
    recordNavigation(sessionId, {
      outcome: 'CANCELLED',
      message: clicked
        ? 'Stopped waiting. The page had already been asked to continue - if it moves on, the panel follows it.'
        : 'Cancelled before anything was clicked.',
      fromStep,
      toStep: fromStep,
      errors: [],
    })
  if (cancelledNext.has(sessionId)) return cancelled(false)

  // Unreadable controls cannot be checked, so they never block - the page's own validation will.
  const blocking = before.fields.filter((field) => field.required && !field.value && !field.valueUnknown)
  if (blocking.length && !force) {
    return recordNavigation(sessionId, {
      outcome: 'BLOCKED',
      message: `${plural(blocking.length, 'required field')} still empty on this page. Fill ${
        blocking.length === 1 ? 'it' : 'them'
      } first - or continue anyway if the page already has ${blocking.length === 1 ? 'it' : 'them'}.`,
      fromStep,
      toStep: fromStep,
      errors: before.report.validationErrors,
      blockingFields: blocking,
    })
  }

  let autoCorrected = 0

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (cancelledNext.has(sessionId)) return cancelled(attempt > 0)

    // 2. Click.
    const click = await sendTabMessage(tabId, 'content/clickNext')
    if (!click.clicked) {
      return recordNavigation(sessionId, {
        outcome: click.reason,
        message:
          click.reason === 'SUBMIT_REFUSED'
            ? `This looks like the final step. Review everything, press "${click.label ?? 'Submit'}" on the page yourself, then press Done here.`
            : 'No Next or Continue button was found on this page. Move on by hand - the panel will follow.',
        fromStep,
        toStep: fromStep,
        errors: [],
        ...(click.label ? { controlLabel: click.label } : {}),
      })
    }

    // 3. Wait for the page to move.
    const moved = await awaitNavigation(tabId, click.page)
    // A page that already moved is followed even if Cancel came late; otherwise stop here.
    if (moved.change !== 'new-page' && (moved.cancelled || cancelledNext.has(sessionId))) return cancelled(true)

    if (moved.change === 'new-page') {
      // 4a. New page: record the step and scan it (autofilling it if it is new).
      const after = await runPagePass(sessionId, 'follow')
      const toStep = after.session.currentStep
      const returned = after.transition === 'returned'
      const filledCount = after.report.filled.length
      const askCount = after.report.ask.length

      return recordNavigation(sessionId, {
        outcome: returned ? 'RETURNED' : 'ADVANCED',
        message: returned
          ? `The site went back to step ${toStep}. Check that page for anything it rejected.`
          : [
              `On step ${toStep}.`,
              filledCount ? `Filled ${plural(filledCount, 'field')}.` : '',
              askCount ? `${plural(askCount, 'field')} need your input.` : '',
            ]
              .filter(Boolean)
              .join(' '),
        fromStep,
        toStep,
        controlLabel: click.label,
        errors: after.report.validationErrors,
        ...(autoCorrected ? { autoCorrected } : {}),
      })
    }

    // 4b. Still here. If the page complained, one automatic correction pass - it
    // only ever fills empty fields the planner is confident about - then retry.
    if (attempt === 0 && (moved.errors.length || moved.change === 'modified')) {
      const fix = await runPagePass(sessionId, 'autofill')
      if (fix.report.filled.length) {
        autoCorrected = fix.report.filled.length
        continue
      }
    }

    const final = await runPagePass(sessionId, 'scan')
    const errors = moved.errors.length ? moved.errors : final.report.validationErrors

    if (errors.length) {
      return recordNavigation(sessionId, {
        outcome: 'VALIDATION_FAILED',
        message: `The page did not advance and is showing ${plural(errors.length, 'error')}. Fix ${
          errors.length === 1 ? 'it' : 'them'
        } on the page, then try again.`,
        fromStep,
        toStep: fromStep,
        controlLabel: click.label,
        errors,
        ...(autoCorrected ? { autoCorrected } : {}),
      })
    }

    return recordNavigation(sessionId, {
      outcome: 'NO_CHANGE',
      message: moved.timedOut
        ? `Clicked "${click.label}", but the page did not change within ${NAVIGATION_TIMEOUT_MS / 1000}s. It may still be loading - check the tab.`
        : `Clicked "${click.label}". The page updated but stayed on the same step.`,
      fromStep,
      toStep: fromStep,
      controlLabel: click.label,
      errors: [],
      ...(autoCorrected ? { autoCorrected } : {}),
    })
  }

  // Unreachable: the loop always returns on its second attempt.
  throw new Error('Navigation ended without a result.')
}

/**
 * Waits for the page to change after a click.
 *
 * A full page load tears the content script down mid-wait, which surfaces here as
 * a closed message port. That is navigation, not failure: wait for the new
 * document, re-inject, and compare it against the page we left.
 */
async function awaitNavigation(
  tabId: number,
  baseline: PageFingerprint,
): Promise<TabMessageMap['content/awaitChange']['res']> {
  try {
    return await sendTabMessage(tabId, 'content/awaitChange', {
      baseline,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
    })
  } catch {
    if (!(await tabExists(tabId))) throw new Error('The job tab was closed during navigation.')
    await waitForTabLoad(tabId)
    await ensureContentScript(tabId)
    return sendTabMessage(tabId, 'content/awaitChange', { baseline, timeoutMs: 8_000 })
  }
}

async function recordNavigation(
  sessionId: string,
  result: Omit<NavigationResult, 'at'>,
): Promise<NavigationResult> {
  const full: NavigationResult = { ...result, at: Date.now() }
  const updated = await patchSession(sessionId, { lastNavigation: full })
  broadcast({ event: 'session/updated', session: updated })

  const details = {
    outcome: full.outcome,
    fromStep: full.fromStep,
    toStep: full.toStep,
    control: full.controlLabel,
    errors: full.errors.map((e) => e.message),
    ...(full.blockingFields?.length ? { blocking: full.blockingFields.map((f) => f.label) } : {}),
    ...(full.autoCorrected ? { autoCorrected: full.autoCorrected } : {}),
  }
  if (NAVIGATION_PROBLEMS.has(full.outcome)) {
    void recordIncident({
      kind: `next-${full.outcome.toLowerCase().replace(/_/g, '-')}`,
      message: full.message,
      origin: 'page/next',
      sessionId,
      data: details,
    })
  } else {
    // BLOCKED is "waiting for your answers", not a fault; the timeline keeps which fields.
    log(full.outcome === 'BLOCKED' ? 'warn' : 'info', 'navigation', `${full.outcome}: ${full.message}`, {
      sessionId,
      data: details,
    })
  }
  return full
}

/** Next outcomes that mean the extension could not do its job on this page. */
const NAVIGATION_PROBLEMS = new Set<NavigationResult['outcome']>(['VALIDATION_FAILED', 'NO_CHANGE', 'NO_CONTROL', 'RETURNED'])

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * Scan and Autofill act on the page the user is looking at. When that is a web page
 * other than the application's tab (the form opened somewhere the extension did not
 * see - a redirect, a link copied into a new tab), the application moves to it.
 * Never a chat tab, never a tab that belongs to another application.
 */
async function adoptViewedTab(sessionId: string): Promise<void> {
  const session = await getSession(sessionId)
  if (!session) return
  const [viewed] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (viewed?.id === undefined || viewed.id === session.tabId || !viewed.url) return
  if (!/^https?:\/\//i.test(viewed.url)) return
  if (/^https:\/\/([a-z0-9-]+\.)?(chatgpt\.com|chat\.openai\.com|claude\.ai)\//i.test(viewed.url)) return
  const owner = await findSessionForTab(viewed.id)
  if (owner && owner.id !== session.id) return
  const updated = await patchSession(session.id, { tabId: viewed.id })
  broadcast({ event: 'session/updated', session: updated })
}

/** Resolves the tab a session is attached to, or explains how to get one. */
async function requireSessionTab(session: ApplicationSession): Promise<number> {
  const tabId = await resolveSessionTab(session)
  if (tabId !== undefined) return tabId

  throw new Error(
    'The job tab is not open. Use "Open in new tab" in the Current Application card first.',
  )
}

/**
 * The session's tab if it still exists; otherwise an open tab showing this
 * application (after a browser restart tab ids change, but the pages come back).
 */
async function resolveSessionTab(session: ApplicationSession): Promise<number | undefined> {
  if (session.tabId !== undefined && (await tabExists(session.tabId))) return session.tabId

  const wanted = new Set(
    [session.lastPageUrl, session.jobUrl].filter((url): url is string => Boolean(url)).map(pageUrl),
  )
  const tabs = await chrome.tabs.query({})
  const match = tabs.find((tab) => tab.id !== undefined && tab.url && wanted.has(pageUrl(tab.url)))
  if (match?.id === undefined) return undefined

  const updated = await patchSession(session.id, { tabId: match.id })
  broadcast({ event: 'session/updated', session: updated })
  return match.id
}

// ---------------------------------------------------------------------------
// Unattended run: into the form, and the approved submit
// ---------------------------------------------------------------------------

const ENTER_FORM_TIMEOUT_MS = 30_000

/**
 * From the job posting into its application form. Waits a moment for a form that
 * renders late; then opens an embedded form in the tab, or presses "Apply". Done
 * when the session's tab (which may be a new one "Apply" opened) shows a form.
 */
async function enterForm(sessionId: string): Promise<{ entered: boolean; message: string }> {
  const started = Date.now()
  let pressed: string | null = null
  let lastError = ''
  /** Each Apply button is pressed and each embedded form opened once. */
  const clicked = new Set<string>()
  const opened = new Set<string>()

  while (Date.now() - started < ENTER_FORM_TIMEOUT_MS) {
    const session = await getSession(sessionId)
    if (!session) throw new Error('That application session no longer exists.')
    const tabId = await resolveSessionTab(session)
    if (tabId !== undefined) {
      try {
        await ensureContentScript(tabId)
        const scan = await sendTabMessage(tabId, 'content/scanFields')
        const applyEntry: string | null = (await sendTabMessage(tabId, 'content/findApply')).label
        const action = nextEnterAction(
          { fields: scan.fields, embeddedForms: scan.embeddedForms, applyEntry },
          { elapsedMs: Date.now() - started, opened, pressed: clicked },
        )
        if (action.kind === 'entered') {
          log('info', 'enter-form', pressed ? `Form reached (${pressed})` : 'The form is on the job page', { sessionId, url: scan.url })
          return { entered: true, message: pressed ? `Opened the form (${pressed}).` : 'The form is on the job page.' }
        }
        if (action.kind === 'open') {
          // The hiring site's form in a frame (Greenhouse on cast.ai): open it in the tab itself.
          opened.add(action.url)
          await chrome.tabs.update(tabId, { url: action.url })
          pressed = 'the application form embedded in the page, opened directly'
          log('info', 'enter-form', `Opened the embedded form ${action.url}`, { sessionId, url: action.url })
          await sleep(1_500)
          continue
        }
        if (action.kind === 'press') {
          const apply = await sendTabMessage(tabId, 'content/clickApply')
          if (apply.clicked) {
            clicked.add(action.label)
            pressed = `pressed "${apply.label ?? action.label}"`
          }
        }
      } catch (error) {
        // Mid-navigation the page cannot answer; the next round will.
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    await sleep(1_000)
  }

  return {
    entered: false,
    message: pressed
      ? `Tried to open the form (${pressed}), but no application form appeared. Open it by hand, then press Continue.`
      : `No application form and no Apply button were found on the page.${lastError ? ` (${lastError})` : ''}`,
  }
}

/** Run items being submitted right now: a double press must not submit twice. */
const submitting = new Set<string>()

/**
 * The user approved: check the page once more, press its Submit, and record the
 * application as Applied only when the site visibly confirms it.
 */
async function approveSubmit(key: string): Promise<void> {
  // Claimed before the first await: a second press (panel + notification) returns here.
  if (submitting.has(key)) return
  submitting.add(key)
  const item = await getRunItem(key).catch(() => null)
  if (!item || item.state !== 'ready' || !item.sessionId) {
    submitting.delete(key)
    throw new Error('That application is no longer waiting for approval.')
  }
  const sessionId = item.sessionId
  const mark = (state: RunItem['state'], reason?: string, problems?: string[]) => {
    const { reason: _r, problems: _p, ...rest } = item
    return setRunItem({ ...rest, state, ...(reason ? { reason } : {}), ...(problems?.length ? { problems } : {}) })
  }

  try {
    await mark('submitting', 'Submitting...')

    // The page may have changed while it waited (a timeout, a field cleared).
    const pass = await runPagePass(sessionId, 'scan')
    const check = preSubmitCheck(pass.session, pass.report)
    if (check.blocking.length) {
      await mark('needs-help', `Not submitted: ${check.blocking[0]}`, check.blocking)
      return
    }

    const tabId = await requireSessionTab(pass.session)
    const click = await sendTabMessage(tabId, 'content/clickSubmit')
    if (!click.clicked) {
      await mark('needs-help', 'Not submitted: the Submit button is no longer on the page.')
      return
    }
    log('info', 'run-submit', `Pressed "${click.label}" after your approval`, { sessionId, url: pass.report.url })

    const moved = await awaitNavigation(tabId, click.page)
    const after = await runPagePass(sessionId, 'scan').catch(() => null)
    const confirmed =
      Boolean(after?.session.confirmationDetected) ||
      (moved.change === 'new-page' && (after?.report.totalFields ?? 0) < MIN_FIRST_STEP_FIELDS)
    const errors = moved.errors.length ? moved.errors : (after?.report.validationErrors ?? [])

    if (confirmed) {
      try {
        await finishSession(sessionId, 'APPLIED', 'Submitted by autopilot after your approval')
      } catch (error) {
        await mark('check', `Submitted and confirmed, but the job list was not updated: ${errorMessage(error)}`)
        return
      }
      await mark('submitted')
      // Its work is done; keep the run window to the applications still open.
      setTimeout(() => void chrome.tabs.remove(tabId).catch(() => undefined), 4_000)
      return
    }

    if (errors.length) {
      await mark('needs-help', `The site did not accept it: ${errors[0]!.message}`, errors.map((e) => e.message))
      void recordIncident({ kind: 'submit-rejected', message: errors[0]!.message, origin: 'run/approve', sessionId, data: { errors } })
      return
    }

    await mark('check', 'Submitted, but no confirmation page was seen. Check the tab; press Done there if it went through.')
    void recordIncident({ kind: 'submit-unconfirmed', message: 'No confirmation after an approved submit', origin: 'run/approve', sessionId })
  } catch (error) {
    await mark('needs-help', `Submit failed: ${errorMessage(error)}`)
    void recordIncident({ kind: 'submit-failed', message: errorMessage(error), origin: 'run/approve', sessionId })
  } finally {
    submitting.delete(key)
  }
}

/** Brings the application's tab to the front so the user can check it. */
async function reviewRunItem(key: string): Promise<void> {
  const item = await getRunItem(key)
  const session = item?.sessionId ? await getSession(item.sessionId) : null
  if (!session) throw new Error('That application is already closed.')

  let tabId = await resolveSessionTab(session)
  if (tabId === undefined) {
    const { windowId } = await runSlot.get()
    const windowOpen = windowId !== undefined && (await chrome.windows.get(windowId).then(() => true, () => false))
    const tab = await chrome.tabs.create({ url: session.lastPageUrl ?? session.jobUrl, active: true, ...(windowOpen ? { windowId } : {}) })
    tabId = tab.id
    await patchSession(session.id, { tabId })
  }
  if (tabId === undefined) return
  await chrome.tabs.update(tabId, { active: true })
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
  await setActiveSession(session.id)
  broadcast({ event: 'session/updated', session: await getSession(session.id) })
}

chrome.notifications.onButtonClicked.addListener((id, index) => {
  const key = keyOfNotification(id)
  if (!key) return
  void (async () => {
    const item = await getRunItem(key)
    const action = item ? NOTIFICATION_BUTTONS[item.state]?.[index] : undefined
    if (action === 'submit') await approveSubmit(key)
    else await reviewRunItem(key)
  })().catch((error) => recordIncident({ kind: 'run-notification', message: errorMessage(error), origin: 'notification', capture: false }))
})

chrome.notifications.onClicked.addListener((id) => {
  const key = keyOfNotification(id)
  if (key) void reviewRunItem(key).catch(() => undefined)
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Tab + content script helpers
// ---------------------------------------------------------------------------

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId)
    return true
  } catch {
    return false
  }
}

/** Resolves once the tab reports `complete`, or after a timeout. */
function waitForTabLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }

    const listener = (changedTabId: number, changeInfo: { status?: string }) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') finish()
    }

    const timer = setTimeout(finish, timeoutMs)
    chrome.tabs.onUpdated.addListener(listener)

    // A tab closed while loading: stop waiting at once (not a crash, not a 20s wait).
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish()
      },
      finish,
    )
  })
}

/**
 * The declared content script covers pages loaded after install. For a tab that
 * predates the install (or a reload race) we inject the same bundle on demand.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendTabMessage(tabId, 'content/ping')
    return
  } catch {
    /* fall through to injection */
  }

  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? []
  if (!files.length) throw new Error('No content script is registered in the manifest.')

  await chrome.scripting.executeScript({ target: { tabId }, files })
  await sendTabMessage(tabId, 'content/ping')
}

async function extractJobInfo(
  sessionId: string,
  tabId: number,
): Promise<ApplicationSession | null> {
  await ensureContentScript(tabId)
  const info = await sendTabMessage(tabId, 'content/extractJob')

  const session = await getSession(sessionId)
  if (!session) return null

  // A resume, cover letter or answer is written for one posting. If this scan found a
  // different posting (the tab moved to another job), they no longer apply to what
  // is shown, so they are cleared rather than silently carried over.
  const previous = session.jobInfo
  const changedPosting =
    previous !== undefined &&
    isDifferentPosting(
      { ...(previous.url ? { url: previous.url } : {}), title: previous.title, description: previous.description },
      { url: info.url, title: info.title, description: info.description },
    )

  const updated = await patchSession(sessionId, {
    jobInfo: {
      url: info.url,
      title: info.title,
      company: info.company,
      location: info.location,
      description: info.description,
      source: info.source,
      confidence: info.confidence,
      extractedAt: info.extractedAt,
    },
    ...(changedPosting
      ? {
          resume: undefined,
          coverLetter: undefined,
          answers: undefined,
          pendingAi: undefined,
          autopilot: undefined,
          tailoredResume: undefined,
          resumeApproved: undefined,
        }
      : {}),
    // Fill in blanks the sheet left empty, but never overwrite what the user typed.
    company: session.company || info.company,
    position: session.position || info.title,
    status: session.status === 'ANALYZING' ? 'RESUME_REVIEW' : session.status,
  })

  broadcast({ event: 'session/updated', session: updated })
  log(info.confidence < 0.5 ? 'warn' : 'info', 'job-description', `Read the posting from ${info.source} (confidence ${info.confidence.toFixed(2)}, ${info.description.length} chars)`, {
    sessionId,
    url: info.url,
  })
  return updated
}
