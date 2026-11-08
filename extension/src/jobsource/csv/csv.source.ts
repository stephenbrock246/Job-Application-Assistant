/**
 * CSV job source.
 *
 * Reads and writes the working copy held in chrome.storage.local. A Chrome
 * extension cannot write to an arbitrary path on disk from a service worker, so
 * the model is deliberately explicit: edits land in the working copy immediately,
 * and the user saves them back to the file from the side panel.
 *
 * The unsaved-changes counter exists so that the working copy never silently
 * diverges from the file the user thinks is up to date.
 */

import { parseCsv, serializeCsv } from './csv'
import {
  buildColumnMap,
  missingRequiredColumns,
  missingWritableColumns,
  parseRows,
} from '../row-parser'
import { COLUMN_LABELS } from '@/shared/constants/sheet'
import { jobTableSlot, requireJobTable } from '@/storage/job-table'
import { JobSourceNotConfiguredError, type JobSource, type JobSourceReadResult } from '../job-source.interface'
import type { SheetJobPatch } from '@/shared/types/job'
import type { CsvImportResult, JobSourceId, JobSourceStatus, LocalJobTable } from '@/shared/types/source'
import type { SheetColumnKey } from '@/shared/types/sheet'

export class CsvJobSource implements JobSource {
  readonly id: JobSourceId = 'csv'
  readonly label = 'CSV file'

  async getStatus(): Promise<JobSourceStatus> {
    const table = await jobTableSlot.get()
    if (!table) {
      return {
        id: this.id,
        label: this.label,
        connected: false,
        detail: 'No file imported',
        canWriteBack: false,
      }
    }

    const jobs = parseRows(table.records, table.headerRowIndex, table.columnMap, table.fileName)
    const missing = missingWritableColumns(table.columnMap)

    return {
      id: this.id,
      label: this.label,
      connected: true,
      detail: `${table.fileName} (${jobs.length})`,
      canWriteBack: missing.length === 0,
      unsavedChanges: table.unsavedChanges,
      canSaveInPlace: table.hasFileHandle,
    }
  }

  async readJobs(): Promise<JobSourceReadResult> {
    const table = await requireJobTable()
    const headers = table.records[table.headerRowIndex] ?? []

    return {
      jobs: parseRows(table.records, table.headerRowIndex, table.columnMap, table.fileName),
      headers,
      columnMap: table.columnMap,
    }
  }

  async updateRow(rowNumber: number, patch: SheetJobPatch): Promise<void> {
    const table = await requireJobTable()
    const index = rowNumber - 1
    if (index <= table.headerRowIndex || index >= table.records.length) {
      throw new Error(`Row ${rowNumber} is outside the imported file.`)
    }

    const entries: [SheetColumnKey, string][] = []
    if (patch.status !== undefined) entries.push(['status', patch.status])
    if (patch.appliedDate !== undefined) entries.push(['appliedDate', patch.appliedDate])
    if (patch.resume !== undefined) entries.push(['resume', patch.resume])
    if (patch.other !== undefined) entries.push(['other', patch.other])

    const width = (table.records[table.headerRowIndex] ?? []).length
    const records = [...table.records]
    // Pad only the row we are writing. Widening untouched rows would rewrite parts
    // of the user's file we were never asked to change.
    const row = [...(records[index] ?? [])]
    while (row.length < width) row.push('')

    const unmapped: SheetColumnKey[] = []
    for (const [key, value] of entries) {
      const column = table.columnMap[key]
      if (column === undefined) {
        unmapped.push(key)
        continue
      }
      row[column] = value
    }

    if (unmapped.length) {
      throw new Error(
        `The CSV has no ${unmapped.map((key) => COLUMN_LABELS[key]).join(', ')} column, so that value cannot be recorded. Re-import with "add missing columns" enabled.`,
      )
    }

    records[index] = row
    await jobTableSlot.set({
      ...table,
      records,
      unsavedChanges: table.unsavedChanges + 1,
    })
  }

  async verifyRow(rowNumber: number, expectedJobLink: string): Promise<boolean> {
    const table = await requireJobTable()
    const column = table.columnMap.jobLink
    if (column === undefined || !expectedJobLink) return true

    const actual = (table.records[rowNumber - 1]?.[column] ?? '').trim()
    return actual === expectedJobLink.trim()
  }
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

/**
 * Parses an uploaded CSV into the working copy.
 *
 * Unlike a Google Sheet we own this document, so a file missing the Applied Date
 * or Resume column can simply have it appended rather than losing those writes.
 */
export async function importCsv(options: {
  fileName: string
  text: string
  headerRowIndex?: number
  addMissingColumns: boolean
  hasFileHandle: boolean
}): Promise<CsvImportResult> {
  const parsed = parseCsv(options.text)
  if (!parsed.records.length) throw new Error('That file appears to be empty.')

  const headerRowIndex = options.headerRowIndex ?? findHeaderRow(parsed.records)
  let headers = [...(parsed.records[headerRowIndex] ?? [])]
  let columnMap = buildColumnMap(headers)

  const missingRequired = missingRequiredColumns(columnMap)
  if (missingRequired.length) {
    throw new Error(
      `The file is missing required column(s): ${missingRequired
        .map((key) => COLUMN_LABELS[key])
        .join(', ')}. Expected headers such as "Job Link" and "Status".`,
    )
  }

  const records = [...parsed.records]
  const addedColumns: string[] = []

  if (options.addMissingColumns) {
    // Only the header row grows. Data rows stay exactly as the user wrote them;
    // a row shorter than the header simply reads as empty in the new columns.
    for (const key of missingWritableColumns(columnMap)) {
      headers = [...headers, COLUMN_LABELS[key]]
      addedColumns.push(COLUMN_LABELS[key])
    }
    records[headerRowIndex] = headers
    columnMap = buildColumnMap(headers)
  }

  const table: LocalJobTable = {
    fileName: options.fileName,
    records,
    headerRowIndex,
    delimiter: parsed.delimiter,
    eol: parsed.eol,
    hadBom: parsed.hadBom,
    columnMap,
    importedAt: Date.now(),
    unsavedChanges: 0,
    lastSavedAt: null,
    hasFileHandle: options.hasFileHandle,
  }

  await jobTableSlot.set(table)

  return {
    fileName: options.fileName,
    headers,
    jobCount: parseRows(records, headerRowIndex, columnMap, options.fileName).length,
    missingColumns: missingWritableColumns(columnMap).map((key) => COLUMN_LABELS[key]),
    addedColumns,
  }
}

/** Serialises the working copy back to CSV text for the panel to write out. */
export async function exportCsv(): Promise<{ fileName: string; text: string }> {
  const table = await jobTableSlot.get()
  if (!table) throw new JobSourceNotConfiguredError('No CSV is loaded.')

  return {
    fileName: table.fileName,
    text: serializeCsv(table.records, table.delimiter, table.eol, table.hadBom),
  }
}

export async function markSaved(hasFileHandle: boolean): Promise<void> {
  await jobTableSlot.update((table) =>
    table ? { ...table, unsavedChanges: 0, lastSavedAt: Date.now(), hasFileHandle } : table,
  )
}

/**
 * Finds the header row, tolerating files that begin with a title or blank lines.
 * Scores each of the first few rows by how many canonical columns it resolves.
 */
export function findHeaderRow(records: string[][]): number {
  let bestIndex = 0
  let bestScore = -1

  for (let i = 0; i < Math.min(records.length, 10); i += 1) {
    const row = records[i]
    if (!row) continue
    const score = Object.keys(buildColumnMap(row)).length
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  return bestIndex
}
