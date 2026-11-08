/**
 * Job queue types.
 *
 * A `SheetJob` is one row of the user's Google Sheet. A `JobInfo` is what we scrape
 * off the actual job posting page. They are deliberately separate: the sheet is the
 * source of truth for *what to apply to*, the page is the source of truth for
 * *what the job actually is*.
 */

/** Normalised status, derived from the free-text Status cell. */
export type JobStatus =
  | 'READY'
  | 'IN_PROGRESS'
  | 'APPLIED'
  | 'FAILED'
  | 'INTRO_CALL'
  | 'INTERVIEW'
  | 'OFFER'
  | 'UNKNOWN'

/** Statuses that still require the user to do something. */
export const ACTIONABLE_STATUSES: readonly JobStatus[] = ['READY', 'IN_PROGRESS']

export interface SheetJob {
  /** 1-based row number in the sheet. This is the write-back address - never lose it. */
  rowNumber: number
  /** Stable id for React keys and session lookup: `${spreadsheetId}:${sheetName}:${rowNumber}`. */
  id: string

  date: string
  jobLink: string
  company: string
  position: string
  /** Raw Status cell text, exactly as it appears in the sheet. */
  statusRaw: string
  /** Status normalised into our enum. */
  status: JobStatus
  other: string
  appliedDate: string
  resume: string
}

/** Fields we are allowed to write back to a sheet row. */
export interface SheetJobPatch {
  status?: string
  appliedDate?: string
  resume?: string
  other?: string
}

/** Information extracted from the live job posting page. */
export interface JobInfo {
  url: string
  /** Page/job title as posted. */
  title: string
  company: string
  location: string
  /** Plain-text job description. This is what feeds resume tailoring. */
  description: string
  /** Which extraction strategy produced this, e.g. "generic:jsonld" or "greenhouse". */
  source: string
  /** 0-1. Low confidence means the user should sanity-check before we tailor a resume. */
  confidence: number
  extractedAt: number
}

/** Reasons offered when the user marks a job as Failed / skipped (spec section 24). */
export const SKIP_REASONS = [
  'Required language',
  'Required experience',
  'Location restriction',
  'Expired job',
  'Work authorization',
  'Salary',
  'Duplicate',
  'Other',
] as const

export type SkipReason = (typeof SKIP_REASONS)[number]
