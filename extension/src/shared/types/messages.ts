/**
 * Typed message contract.
 *
 * Side panel -> background uses `RuntimeMessageMap`.
 * Background -> content script uses `TabMessageMap`.
 *
 * Both are request/response maps so `sendMessage` can infer the result type from
 * the message type alone. Every handler returns `Result<T>` rather than throwing
 * across the port boundary, because a thrown error in a service worker turns into
 * an opaque `lastError` string at the call site.
 */

import type { JobInfo, SheetJob, SheetJobPatch, SkipReason } from './job'
import type {
  ApplicationSession,
  AutofillReport,
  FillInstruction,
  FillOutcome,
  NavigationResult,
  PageChange,
  PageFingerprint,
  ScanResult,
  ValidationError,
} from './application'
import type { SheetConnectionInfo } from './sheet'
import type { AIProviderStatus, PendingAITask } from './ai'
import type { DraftedAnswer } from './resume'
import type { GoogleAccountInfo } from './settings'
import type { CsvImportResult, JobSourceStatus } from './source'
import type { IncidentInput, LogLevel, PageSnapshot } from './diagnostics'
import type { RunItem, RunState } from './run'

/**
 * Session fields the side panel writes (resume, cover letter, drafted answers).
 * `null` clears a field; JSON messaging cannot carry `undefined`.
 * The two keyed records merge entry by entry (an entry set to `null` is deleted),
 * so two tasks finishing close together cannot overwrite each other.
 */
export type WritingPatch = {
  [K in 'resume' | 'coverLetter' | 'tailoredResume' | 'resumeApproved' | 'autopilot']?: ApplicationSession[K] | null
} & {
  answers?: Record<string, DraftedAnswer | null>
  pendingAi?: Record<string, PendingAITask | null>
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

export interface QueueSnapshot {
  jobs: SheetJob[]
  counts: {
    ready: number
    inProgress: number
    applied: number
    failed: number
    other: number
    total: number
  }
  fetchedAt: number
}

export interface RuntimeMessageMap {
  /** Auth */
  'auth/status': { req: void; res: GoogleAccountInfo | null }
  'auth/connect': { req: void; res: GoogleAccountInfo }
  'auth/disconnect': { req: void; res: null }

  /** Job source (CSV or Google Sheets) */
  'source/status': { req: void; res: JobSourceStatus }
  'source/queue': { req: { force?: boolean } | void; res: QueueSnapshot }
  'source/updateRow': { req: { rowNumber: number; patch: SheetJobPatch }; res: null }

  /** CSV source. File I/O happens in the side panel; the worker owns the data. */
  'csv/import': {
    req: { fileName: string; text: string; addMissingColumns: boolean; hasFileHandle: boolean }
    res: CsvImportResult
  }
  'csv/export': { req: void; res: { fileName: string; text: string } }
  'csv/markSaved': { req: { hasFileHandle: boolean }; res: null }

  /** Google Sheets source, optional */
  'sheets/inspect': { req: { spreadsheetId: string }; res: SheetConnectionInfo }
  'sheets/connect': {
    req: { spreadsheetId: string; sheetName: string; headerRow: number }
    res: { detectedHeaders: string[]; missing: string[] }
  }

  /** Job flow */
  /** windowId: open the job in that window (the unattended run's), without focusing it. */
  'job/open': { req: { jobId: string; windowId?: number }; res: ApplicationSession }
  'job/markDone': { req: { sessionId: string; notes?: string }; res: null }
  'job/markFailed': { req: { sessionId: string; reason: SkipReason; notes?: string }; res: null }
  'job/abandon': { req: { sessionId: string }; res: null }
  'job/focusTab': { req: { sessionId: string }; res: null }
  /** The application continues in the tab the user is looking at (a form they opened themselves). */
  'job/adoptViewedTab': { req: { sessionId: string }; res: null }

  /** Session */
  'session/active': { req: void; res: ApplicationSession | null }
  'session/refreshJobInfo': { req: { sessionId: string }; res: ApplicationSession }
  /** The user's own corrections: company, position, or a pasted job description. */
  'session/updateJob': {
    req: { sessionId: string; company?: string; position?: string; description?: string }
    res: ApplicationSession | null
  }
  'session/updateWriting': {
    req: { sessionId: string; patch: WritingPatch }
    res: ApplicationSession | null
  }

  /** Application page (phase 3) */
  /** auto: sent by the unattended run - act on the session's own tab, never the tab the user is looking at. */
  'page/scan': { req: { sessionId: string; auto?: boolean }; res: AutofillReport }
  'page/autofill': { req: { sessionId: string; auto?: boolean }; res: AutofillReport }
  /** From a job posting into its application form (clicks "Apply" when the page has no form yet). */
  'page/enterForm': { req: { sessionId: string }; res: { entered: boolean; message: string } }
  'page/answerField': {
    req: {
      sessionId: string
      fieldId: string
      value: string
      saveAsDefault: boolean
      canonicalField?: string
      label: string
    }
    res: AutofillReport
  }
  'page/highlightField': { req: { sessionId: string; fieldId: string }; res: null }
  'page/openEmbedded': { req: { sessionId: string; url: string }; res: null }
  'page/attachFile': {
    req: { sessionId: string; fieldId: string; fileName: string; mime: string; base64: string }
    res: { attached: boolean; error?: string }
  }

  /** Multi-page (phase 4) */
  'page/next': { req: { sessionId: string; force?: boolean }; res: NavigationResult }
  /** Stop a Next in progress: stop waiting for the page to change. */
  'page/cancelNext': { req: { sessionId: string }; res: null }
  /** Sent by the content script's watcher when the user changes page themselves. */
  'page/observed': {
    req: { change: Exclude<PageChange, 'same'>; page: PageFingerprint }
    res: null
  }

  /** AI */
  'ai/status': { req: void; res: AIProviderStatus }

  /** Black-box recorder. The panel reads the records from storage; only the worker writes them. */
  'diag/report': { req: IncidentInput; res: { incidentId: string | null } }
  'diag/log': {
    req: { level: LogLevel; kind: string; message: string; sessionId?: string; data?: unknown }
    res: null
  }
  'diag/clear': { req: void; res: null }

  /** Unattended run. The panel's runner reports; the worker owns the state and the notifications. */
  'run/start': { req: { windowId: number }; res: RunState }
  'run/stop': { req: { status?: string } | void; res: null }
  'run/progress': { req: { status: string; currentKey?: string | null }; res: null }
  'run/item': { req: RunItem; res: null }
  /** The user pressed Submit for a ready application. */
  'run/approve': { req: { key: string }; res: null }
  /** Show that application's tab (focuses the run window). */
  'run/review': { req: { key: string }; res: null }
  'run/dismiss': { req: { key: string }; res: null }
}

export interface TabMessageMap {
  'content/ping': { req: void; res: { ready: true; url: string } }
  'content/extractJob': { req: void; res: JobInfo }
  'content/scanFields': { req: void; res: ScanResult }
  'content/fillFields': { req: { instructions: FillInstruction[] }; res: FillOutcome[] }
  'content/detectErrors': { req: void; res: ValidationError[] }
  'content/highlightField': { req: { fieldId: string }; res: null }
  'content/watch': { req: { enabled: boolean }; res: null }
  'content/attachFile': {
    req: { fieldId: string; fileName: string; mime: string; base64: string }
    res: { attached: boolean; error?: string }
  }
  'content/pageState': { req: void; res: { page: PageFingerprint } }
  /** A copy of the page and its fields, for a problem report. */
  'content/snapshot': { req: void; res: PageSnapshot }
  'content/clickNext': {
    req: void
    res: (
      | { clicked: true; label: string }
      | { clicked: false; reason: 'NO_CONTROL' | 'SUBMIT_REFUSED'; label?: string }
    ) & { page: PageFingerprint }
  }
  'content/awaitChange': {
    req: { baseline: PageFingerprint; timeoutMs: number }
    res: { page: PageFingerprint; change: PageChange; errors: ValidationError[]; timedOut: boolean; cancelled?: boolean }
  }
  'content/cancelWait': { req: void; res: null }
  /** Final submit - sent only from the approval flow, after the user pressed Submit. */
  'content/clickSubmit': {
    req: void
    res: ({ clicked: true; label: string } | { clicked: false; reason: 'NO_CONTROL' | 'SUBMIT_REFUSED'; label?: string }) & {
      page: PageFingerprint
    }
  }
  /** "Apply" on a posting page: into the application form. */
  'content/clickApply': { req: void; res: { clicked: boolean; label?: string } }
  /** The posting's "Apply" / "I'm interested" control, without clicking it. */
  'content/findApply': { req: void; res: { label: string | null } }
  /** ChatGPT tab only: type a prompt, send it, return the finished reply. */
  'content/chatgptAsk': {
    /** file: also fetch the file ChatGPT created in its answer. */
    req: { prompt: string; timeoutMs: number; file?: boolean }
    /** file: the CV; coverLetter: a cover letter created in the same answer; ref: the message's reference. */
    res: { reply: string; ref?: string; file?: ChatGptFile | null; coverLetter?: ChatGptFile | null }
  }
  /** Clicks the Download links in the answer to the message carrying `ref`. */
  'content/chatClickDownloads': { req: { ref: string }; res: { clicked: number } }
  'content/chatgptStop': { req: void; res: null }
}

/** A file ChatGPT created: its bytes, or (when the page could not fetch them) a link. */
export interface ChatGptFile {
  name: string
  mime?: string
  base64?: string
  downloadUrl?: string
}

export type RuntimeMessageType = keyof RuntimeMessageMap
export type TabMessageType = keyof TabMessageMap

export type RuntimeEnvelope<T extends RuntimeMessageType = RuntimeMessageType> = {
  type: T
  payload: RuntimeMessageMap[T]['req']
}

export type TabEnvelope<T extends TabMessageType = TabMessageType> = {
  type: T
  payload: TabMessageMap[T]['req']
}

/** Broadcast from background to any open side panel when server-side state changes. */
export type BroadcastEvent =
  | { event: 'queue/updated'; snapshot: QueueSnapshot }
  | { event: 'session/updated'; session: ApplicationSession | null }
  | { event: 'auth/updated'; account: GoogleAccountInfo | null }
  | { event: 'source/updated'; status: JobSourceStatus }
