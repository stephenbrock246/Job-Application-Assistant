/**
 * Google Sheet read straight from its link.
 *
 * No Google Cloud project and no sign-in: every refresh fetches the sheet's live
 * contents from Google's CSV view of the tab into memory (nothing is saved to
 * disk) and runs them through the same parser as an imported CSV, so a job means
 * exactly the same thing whichever way it was read. Row numbers are the sheet's own.
 *
 * Read-only by the user's choice - they update the sheet themselves. Outcomes
 * (Done, Skip, In Progress) are kept as local notes so the queue is right
 * immediately; the panel lists them for copying into the sheet, and a note is
 * dropped as soon as the sheet shows that status.
 */

import { parseCsv } from '../csv/csv'
import { findHeaderRow } from '../csv/csv.source'
import { buildColumnMap, missingRequiredColumns, parseRows } from '../row-parser'
import { JobSourceNotConfiguredError, type JobSource, type JobSourceReadResult } from '../job-source.interface'
import { COLUMN_LABELS, normaliseStatus } from '@/shared/constants/sheet'
import { defineSlot } from '@/storage/base'
import { jobUrlKey } from '@/shared/utils/job-url'
import { ACTIONABLE_STATUSES, type SheetJobPatch } from '@/shared/types/job'
import type { JobSourceId, JobSourceStatus, SheetLinkConfig, SheetLinkUpdate } from '@/shared/types/source'

export const sheetLinkSlot = defineSlot<SheetLinkConfig | null>('sheetLink', () => null)
export const sheetLinkUpdatesSlot = defineSlot<SheetLinkUpdate[]>('sheetLinkUpdates', () => [])

/** Accepts any Google Sheets link (edit, view, share) and finds the sheet and tab. */
export function parseSheetUrl(input: string): { spreadsheetId: string; gid: string } | null {
  const id = /\/spreadsheets\/d\/([a-zA-Z0-9-_]{20,})/.exec(input)?.[1]
  if (!id) return null
  const gid = /[#&?]gid=(\d+)/.exec(input)?.[1] ?? '0'
  return { spreadsheetId: id, gid }
}

// ---------------------------------------------------------------------------
// Downloading the sheet
//
// Google limits how often a sheet's CSV can be downloaded; asked several times in
// a second (open a job = pick it, mark it In Progress, refresh the list) it answers
// with a "too many requests" page instead of the data. So:
//   - one download is shared by everything that asks within a few seconds;
//   - a busy answer is retried after a pause;
//   - while Google stays busy, the copy from the last few minutes is used;
//   - only a sheet that was never readable gets the "share it" message.
// ---------------------------------------------------------------------------

/** A download this recent is reused rather than asked for again. */
const FRESH_MS = 10_000
/** While Google is busy, a copy this recent is used instead of failing. */
const STALE_OK_MS = 10 * 60_000
let retryDelaysMs = [1_500, 4_000, 8_000]

const recent = new Map<string, { at: number; records: string[][] }>()
const inFlight = new Map<string, Promise<string[][]>>()

/** Google answered, but not with the sheet: too many requests, an outage. Worth retrying. */
export class SheetBusyError extends Error {
  constructor(status: number) {
    super(
      `Google Sheets is not answering right now${status ? ` (HTTP ${status})` : ''} - it limits how often a sheet can be read. It is retried automatically; if it lasts, wait a minute and press Refresh.`,
    )
    this.name = 'SheetBusyError'
  }
}

/** For the check scripts: forget downloaded copies, and retry without waiting. */
export function resetSheetCache(options: { retryDelaysMs?: number[] } = {}): void {
  recent.clear()
  inFlight.clear()
  if (options.retryDelaysMs) retryDelaysMs = options.retryDelaysMs
}

/** Fetches the tab's contents (or a copy a few seconds old). Throws a message the user can act on. */
export async function fetchSheetRows(config: Pick<SheetLinkConfig, 'spreadsheetId' | 'gid'>): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${config.spreadsheetId}/export?format=csv&gid=${config.gid}`
  const last = recent.get(url)
  if (last && Date.now() - last.at < FRESH_MS) return last.records

  let pending = inFlight.get(url)
  if (!pending) {
    pending = download(url).finally(() => inFlight.delete(url))
    inFlight.set(url, pending)
  }
  try {
    const records = await pending
    recent.set(url, { at: Date.now(), records })
    return records
  } catch (error) {
    // The sheet was readable minutes ago: Google is busy, not unshared. Carry on with that copy.
    if (last && Date.now() - last.at < STALE_OK_MS && !(error instanceof SheetNotFoundError)) return last.records
    throw error
  }
}

class SheetNotFoundError extends Error {}

async function download(url: string): Promise<string[][]> {
  // Without the browser's Google sign-in first: an "Anyone with the link" sheet needs
  // none, and a signed-in request can be sent to an account chooser instead. With it
  // next, so a private sheet the user can open still works.
  const attempts: RequestCredentials[] = ['omit', 'include', ...retryDelaysMs.map(() => 'include' as const)]
  let busyStatus = 0
  let sawHtml = false
  for (const [index, credentials] of attempts.entries()) {
    if (index >= 2) await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[index - 2]))
    let response: Response
    try {
      response = await fetch(url, { credentials, redirect: 'follow', cache: 'no-store' })
    } catch {
      busyStatus = 0
      continue
    }
    if (response.status === 404) throw new SheetNotFoundError('That sheet or tab was not found. Check the link.')
    const text = await response.text().catch(() => '')
    const html = /^\s*</.test(text) || (response.headers.get('content-type') ?? '').includes('text/html')
    if (response.ok && !html) return parseCsv(text).records
    if (response.status === 429 || response.status >= 500) busyStatus = response.status
    else sawHtml = true
    // A sign-in page for both ways of asking: the sheet is not shared - no point retrying.
    if (index === 1 && sawHtml && !busyStatus) break
  }
  if (busyStatus || !sawHtml) throw new SheetBusyError(busyStatus)
  throw new Error(
    'Google did not share this sheet with the extension (it answered with a sign-in page). In the sheet: Share > General access > "Anyone with the link" > Viewer, then try again.',
  )
}

export class SheetLinkJobSource implements JobSource {
  readonly id: JobSourceId = 'sheet-link'
  readonly label = 'Google Sheet (link)'

  async getStatus(): Promise<JobSourceStatus> {
    const config = await sheetLinkSlot.get()
    if (!config) {
      return { id: this.id, label: this.label, connected: false, detail: 'Paste your sheet link in Settings', canWriteBack: false }
    }
    return {
      id: this.id,
      label: this.label,
      connected: true,
      detail: 'Live from your sheet',
      // "Write-back" here means recording the outcome; the user copies it into the sheet.
      canWriteBack: true,
    }
  }

  async readJobs(): Promise<JobSourceReadResult> {
    const config = await sheetLinkSlot.get()
    if (!config) throw new JobSourceNotConfiguredError('No Google Sheet link yet. Paste it in Settings > Job source.')

    const records = await fetchSheetRows(config)
    if (!records.length) throw new Error('The sheet is empty.')
    const headerRowIndex = findHeaderRow(records)
    const headers = records[headerRowIndex] ?? []
    const columnMap = buildColumnMap(headers)
    const missing = missingRequiredColumns(columnMap)
    if (missing.length) {
      throw new Error(
        `The sheet is missing required column(s): ${missing.map((key) => COLUMN_LABELS[key]).join(', ')}. Expected headers such as "Job Link" and "Status".`,
      )
    }

    const jobs = parseRows(records, headerRowIndex, columnMap, `sheet:${config.spreadsheetId}:${config.gid}`)
    if (JSON.stringify(config.columnMap) !== JSON.stringify(columnMap)) {
      await sheetLinkSlot.set({ ...config, columnMap })
    }

    // Apply local outcome notes; drop the ones the sheet already shows.
    const updates = await sheetLinkUpdatesSlot.get()
    const keep: SheetLinkUpdate[] = []
    for (const update of updates) {
      const job = jobs.find((j) => j.rowNumber === update.rowNumber && jobUrlKey(j.jobLink) === jobUrlKey(update.jobLink))
      if (!job) continue // the row moved or was deleted - the note no longer has a home
      const sheetStatus = job.status
      const noted = normaliseStatus(update.status)
      // The user has updated the sheet (to this or anything later): the note is done.
      if (sheetStatus === noted || !ACTIONABLE_STATUSES.includes(sheetStatus)) continue
      keep.push(update)
      job.statusRaw = update.status
      job.status = noted
      if (update.appliedDate) job.appliedDate = update.appliedDate
      if (update.resume) job.resume = update.resume
      if (update.other) job.other = update.other
    }
    if (keep.length !== updates.length) await sheetLinkUpdatesSlot.set(keep)

    return { jobs, headers, columnMap }
  }

  async updateRow(rowNumber: number, patch: SheetJobPatch): Promise<void> {
    const config = await sheetLinkSlot.get()
    if (!config) throw new JobSourceNotConfiguredError('No Google Sheet link yet.')
    const records = await fetchSheetRows(config)
    const headerRowIndex = findHeaderRow(records)
    const jobs = parseRows(records, headerRowIndex, buildColumnMap(records[headerRowIndex] ?? []), 'x')
    const job = jobs.find((j) => j.rowNumber === rowNumber)
    if (!job) throw new Error(`Row ${rowNumber} is not in the sheet any more.`)

    await sheetLinkUpdatesSlot.update((current) => {
      const others = current.filter((u) => !(u.rowNumber === rowNumber && jobUrlKey(u.jobLink) === jobUrlKey(job.jobLink)))
      const previous = current.find((u) => u.rowNumber === rowNumber && jobUrlKey(u.jobLink) === jobUrlKey(job.jobLink))
      return [
        ...others,
        {
          ...(previous ?? {}),
          rowNumber,
          jobLink: job.jobLink,
          company: job.company,
          position: job.position,
          status: patch.status ?? previous?.status ?? '',
          ...(patch.appliedDate ? { appliedDate: patch.appliedDate } : {}),
          ...(patch.resume ? { resume: patch.resume } : {}),
          ...(patch.other ? { other: patch.other } : {}),
          at: Date.now(),
        },
      ]
    })
  }

  async verifyRow(rowNumber: number, expectedJobLink: string): Promise<boolean> {
    const config = await sheetLinkSlot.get()
    if (!config) return false
    const records = await fetchSheetRows(config)
    const headerRowIndex = findHeaderRow(records)
    const jobs = parseRows(records, headerRowIndex, buildColumnMap(records[headerRowIndex] ?? []), 'x')
    const job = jobs.find((j) => j.rowNumber === rowNumber)
    return Boolean(job) && jobUrlKey(job!.jobLink) === jobUrlKey(expectedJobLink)
  }
}
