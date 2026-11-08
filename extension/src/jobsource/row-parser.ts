/**
 * Row -> SheetJob conversion, shared by every source.
 *
 * Both the CSV and Google Sheets paths funnel through here so a job means exactly
 * the same thing whichever source produced it - including how blank rows are
 * skipped and how a free-text Status becomes a normalised one.
 */

import {
  COLUMN_HEADER_ALIASES,
  COLUMN_ORDER,
  REQUIRED_COLUMNS,
  WRITABLE_COLUMNS,
  normaliseHeader,
  normaliseStatus,
} from '@/shared/constants/sheet'
import type { SheetJob } from '@/shared/types/job'
import type { SheetColumnKey, SheetColumnMap } from '@/shared/types/sheet'

/**
 * Resolves header cells to canonical column keys by name (spec section 21).
 * Source-agnostic on purpose: a CSV header row and a spreadsheet header row are
 * the same problem, and must not drift apart.
 */
export function buildColumnMap(headerCells: string[]): SheetColumnMap {
  const map: SheetColumnMap = {}
  const normalised = headerCells.map(normaliseHeader)
  const taken = new Set<number>()

  // Aliases are tried in their listed order, so the best name wins wherever it is:
  // with "City, State, Status" the Status column is "Status", never the "State"
  // column before it (which status updates would then overwrite). A cell is used once.
  for (const key of COLUMN_ORDER) {
    for (const alias of COLUMN_HEADER_ALIASES[key]) {
      const index = normalised.findIndex((cell, i) => cell === alias && !taken.has(i))
      if (index >= 0) {
        map[key] = index
        taken.add(index)
        break
      }
    }
  }
  return map
}

export interface ParsedRows {
  jobs: SheetJob[]
  headers: string[]
  columnMap: SheetColumnMap
}

/**
 * @param records   every row of the source, including the header row
 * @param headerRowIndex 0-based index of the header row within `records`
 * @param scopeId   namespace for job ids, e.g. a spreadsheet id or a file name
 */
export function parseRows(
  records: string[][],
  headerRowIndex: number,
  columnMap: SheetColumnMap,
  scopeId: string,
): SheetJob[] {
  const cell = (row: string[], key: SheetColumnKey): string => {
    const index = columnMap[key]
    if (index === undefined) return ''
    return (row[index] ?? '').toString().trim()
  }

  const jobs: SheetJob[] = []

  for (let i = headerRowIndex + 1; i < records.length; i += 1) {
    const row = records[i]
    if (!row) continue

    const jobLink = cell(row, 'jobLink')
    const company = cell(row, 'company')
    const position = cell(row, 'position')
    // A row with no link and nothing identifying it is padding, not a job.
    if (!jobLink && !company && !position) continue

    const statusRaw = cell(row, 'status')
    const rowNumber = i + 1

    jobs.push({
      rowNumber,
      id: `${scopeId}:${rowNumber}`,
      date: cell(row, 'date'),
      jobLink,
      company,
      position,
      statusRaw,
      status: normaliseStatus(statusRaw),
      other: cell(row, 'other'),
      appliedDate: cell(row, 'appliedDate'),
      resume: cell(row, 'resume'),
    })
  }

  return jobs
}

export function missingRequiredColumns(map: SheetColumnMap): SheetColumnKey[] {
  return REQUIRED_COLUMNS.filter((key) => map[key] === undefined)
}

export function missingWritableColumns(map: SheetColumnMap): SheetColumnKey[] {
  return WRITABLE_COLUMNS.filter((key) => map[key] === undefined)
}
