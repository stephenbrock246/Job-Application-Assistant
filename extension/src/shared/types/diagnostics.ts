/**
 * The black-box recorder's records.
 *
 * A timeline of what the extension did (`LogEvent`), and an `Incident` for each
 * time something went wrong: what failed, on which job and page, with a screenshot
 * and a copy of the page taken at that moment. The user downloads them as one
 * report so a failure can be reproduced and fixed instead of guessed at.
 */

import type { ApplicationField } from './application'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEvent {
  at: number
  level: LogLevel
  /** Short machine-friendly tag, e.g. "navigation", "fill-rejected", "job-opened". */
  kind: string
  message: string
  sessionId?: string
  url?: string
  data?: unknown
}

/** The list entry for one incident. Its heavy parts live under their own storage key. */
export interface IncidentSummary {
  id: string
  /** First time it happened. */
  at: number
  /** Most recent repeat; equal to `at` when it happened once. */
  lastAt: number
  /** Repeats of the same failure on the same job are counted, not captured again. */
  count: number
  kind: string
  message: string
  /** Where it came from: a message type ("page/next"), "panel", "worker"... */
  origin: string
  /** True when the user pressed "Report a problem" (the failure was not detected). */
  manual?: boolean
  note?: string
  sessionId?: string
  company?: string
  position?: string
  url?: string
  adapter?: string
  hasScreenshot: boolean
  hasSnapshot: boolean
  /** Why there is no screenshot (tab hidden, window minimised...). */
  screenshotNote?: string
}

export interface IncidentDetail {
  id: string
  /** JPEG data URL of the job tab. */
  screenshot?: string
  snapshot?: PageSnapshot
  /** The session as it stood, without the large resume/letter texts. */
  session?: unknown
  /** The events that led up to it. */
  timeline: LogEvent[]
  data?: unknown
}

/** A copy of the page as it looked, values included, readable offline. */
export interface PageSnapshot {
  url: string
  title: string
  html: string
  truncated: boolean
  fields: ApplicationField[]
  adapter: string
  capturedAt: number
}

export interface IncidentInput {
  kind: string
  message: string
  origin: string
  sessionId?: string
  /** Capture the job tab (screenshot + page copy). Defaults to true when a session tab is known. */
  capture?: boolean
  manual?: boolean
  note?: string
  data?: unknown
}
