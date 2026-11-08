/** Job source abstraction: where the job queue is read from and written back to. */

import type { SheetColumnMap } from './sheet'
import type { Eol } from '@/jobsource/csv/csv'

export type JobSourceId = 'csv' | 'google-sheets' | 'sheet-link'

/** A Google Sheet read by its link (no Google Cloud, no sign-in). */
export interface SheetLinkConfig {
  url: string
  spreadsheetId: string
  /** Which tab - from the link's gid; "0" is the first tab. */
  gid: string
  connectedAt: number
  /** Columns found at the last read - used to copy updates in the sheet's own column order. */
  columnMap?: SheetColumnMap
}

/**
 * An outcome recorded in the extension for a sheet it cannot write (Done, Skip,
 * In Progress). It keeps the queue right until the user copies it into the sheet;
 * once the sheet shows it, the note is dropped.
 */
export interface SheetLinkUpdate {
  rowNumber: number
  jobLink: string
  company: string
  position: string
  status: string
  appliedDate?: string
  resume?: string
  other?: string
  at: number
}

export interface JobSourceStatus {
  id: JobSourceId
  label: string
  /** True when the source is configured and readable right now. */
  connected: boolean
  /** One line shown under the source name in the side panel. */
  detail: string
  /** Whether write-back is possible at all (all mapped columns exist). */
  canWriteBack: boolean
  /** CSV only: edits made to the working copy that are not yet in the file. */
  unsavedChanges?: number
  /** CSV only: whether we hold a handle that can overwrite the original file. */
  canSaveInPlace?: boolean
}

/**
 * The imported CSV, held as the extension's working copy.
 *
 * `records` is every row of the file including any preamble above the header, so
 * a save round-trips the document rather than rewriting it. Row numbers used
 * everywhere else in the app are 1-based indices into this array, which keeps them
 * identical in meaning to a spreadsheet row number.
 */
export interface LocalJobTable {
  fileName: string
  records: string[][]
  /** 0-based index into `records` of the header row. */
  headerRowIndex: number
  delimiter: string
  eol: Eol
  hadBom: boolean
  columnMap: SheetColumnMap
  importedAt: number
  /** Number of row writes since the last successful save. */
  unsavedChanges: number
  lastSavedAt: number | null
  /** True once a file handle capable of in-place saving has been stored. */
  hasFileHandle: boolean
}

export interface CsvImportResult {
  fileName: string
  headers: string[]
  jobCount: number
  /** Writable columns that were missing and could not be added. */
  missingColumns: string[]
  /** Columns we appended to the file so write-back works. */
  addedColumns: string[]
}
