import type { JobStatus } from '../types/job'
import type { SheetColumnKey } from '../types/sheet'

/**
 * Header-name resolution (spec section 21): never assume Status is column E.
 * Each canonical column lists the header spellings we accept, normalised
 * (lowercased, non-alphanumerics stripped) before comparison.
 */
export const COLUMN_HEADER_ALIASES: Record<SheetColumnKey, string[]> = {
  date: ['date', 'dateadded', 'datefound', 'addeddate'],
  jobLink: ['joblink', 'link', 'url', 'joburl', 'joblinkurl', 'posting', 'postingurl'],
  company: ['company', 'companyname', 'employer', 'organization'],
  position: ['position', 'role', 'title', 'jobtitle', 'positiontitle'],
  status: ['status', 'applicationstatus', 'state'],
  other: ['other', 'notes', 'note', 'comment', 'comments', 'remarks'],
  appliedDate: ['applieddate', 'dateapplied', 'appliedon', 'applied'],
  resume: ['resume', 'resumefile', 'cv', 'resumeused', 'tailoredresume'],
}

/** Columns without which the extension cannot function. */
export const REQUIRED_COLUMNS: SheetColumnKey[] = ['jobLink', 'status']

/** Columns we write to. Missing ones are reported rather than silently skipped. */
export const WRITABLE_COLUMNS: SheetColumnKey[] = ['status', 'appliedDate', 'resume', 'other']

/** Canonical display order, used when we render the detected-header table. */
export const COLUMN_ORDER: SheetColumnKey[] = [
  'date',
  'jobLink',
  'company',
  'position',
  'status',
  'other',
  'appliedDate',
  'resume',
]

export const COLUMN_LABELS: Record<SheetColumnKey, string> = {
  date: 'Date',
  jobLink: 'Job Link',
  company: 'Company',
  position: 'Position',
  status: 'Status',
  other: 'Other',
  appliedDate: 'Applied Date',
  resume: 'Resume',
}

/** Exact strings we write back into the Status cell. */
export const STATUS_TEXT: Record<Exclude<JobStatus, 'READY' | 'UNKNOWN'>, string> = {
  IN_PROGRESS: 'In Progress',
  APPLIED: 'Applied',
  FAILED: 'Failed',
  INTRO_CALL: 'Intro Call',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
}

/** Free-text status cell -> normalised status. Blank means Ready to Apply. */
export function normaliseStatus(raw: string): JobStatus {
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!value) return 'READY'
  if (value === 'ready' || value === 'readytoapply' || value === 'todo') return 'READY'
  if (value === 'inprogress' || value === 'started' || value === 'applying') return 'IN_PROGRESS'
  if (value === 'applied' || value === 'submitted' || value === 'done') return 'APPLIED'
  if (value === 'failed' || value === 'skipped' || value === 'rejected' || value === 'closed') {
    return 'FAILED'
  }
  if (value === 'introcall' || value === 'intro' || value === 'recruitercall') return 'INTRO_CALL'
  if (value === 'interview' || value === 'interviewing') return 'INTERVIEW'
  if (value === 'offer' || value === 'offerreceived') return 'OFFER'
  return 'UNKNOWN'
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  READY: 'Ready',
  IN_PROGRESS: 'In Progress',
  APPLIED: 'Applied',
  FAILED: 'Failed',
  INTRO_CALL: 'Intro Call',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  UNKNOWN: 'Unknown',
}

/** Normalises a header cell for alias comparison. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '')
}
