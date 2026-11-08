/**
 * Google Sheets client.
 *
 * Rule from the spec that shapes this whole file: columns are resolved by header
 * *name*, never by hard-coded letter. The resolved map is cached on the config,
 * but every read re-reads the header row so a column inserted in the sheet does
 * not silently corrupt write-backs.
 */

import { GOOGLE } from '@/shared/constants/defaults'
import { COLUMN_LABELS } from '@/shared/constants/sheet'
import { buildColumnMap, missingRequiredColumns, parseRows } from '@/jobsource/row-parser'
import { columnLetter, quoteSheetName } from '@/shared/utils/format'
import type { SheetJob, SheetJobPatch } from '@/shared/types/job'
import type { SheetColumnKey, SheetColumnMap, SheetConnectionInfo } from '@/shared/types/sheet'
import { googleFetch } from './auth'

export { buildColumnMap }

export class SheetsError extends Error {
  code: string
  constructor(message: string, code = 'SHEETS_ERROR') {
    super(message)
    this.name = 'SheetsError'
    this.code = code
  }
}

async function readJson<T>(response: Response, context: string): Promise<T> {
  if (response.ok) return (await response.json()) as T

  let detail = `${response.status} ${response.statusText}`
  try {
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error?.message) detail = body.error.message
  } catch {
    /* non-JSON error body */
  }

  if (response.status === 403) {
    throw new SheetsError(
      `${context}: access denied. Make sure this Google account can edit the sheet. (${detail})`,
      'FORBIDDEN',
    )
  }
  if (response.status === 404) {
    throw new SheetsError(`${context}: spreadsheet or tab not found. (${detail})`, 'NOT_FOUND')
  }
  throw new SheetsError(`${context}: ${detail}`)
}

/** Lists the tabs of a spreadsheet so the user can pick one in Settings. */
export async function inspectSpreadsheet(spreadsheetId: string): Promise<SheetConnectionInfo> {
  const url = `${GOOGLE.sheetsApi}/${encodeURIComponent(
    spreadsheetId,
  )}?fields=properties.title,sheets.properties(sheetId,title,index)`

  const response = await googleFetch(url)
  const data = await readJson<{
    properties: { title: string }
    sheets: { properties: { sheetId: number; title: string; index: number } }[]
  }>(response, 'Reading spreadsheet')

  return {
    spreadsheetTitle: data.properties.title,
    tabs: data.sheets.map((s) => ({
      title: s.properties.title,
      sheetId: s.properties.sheetId,
      index: s.properties.index,
    })),
  }
}

/** Raw grid values for a tab, starting at row 1. */
async function readValues(spreadsheetId: string, sheetName: string): Promise<string[][]> {
  const range = `${quoteSheetName(sheetName)}`
  const url = `${GOOGLE.sheetsApi}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(
    range,
  )}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`

  const response = await googleFetch(url)
  const data = await readJson<{ values?: string[][] }>(response, 'Reading sheet values')
  return data.values ?? []
}

export interface SheetReadResult {
  jobs: SheetJob[]
  headers: string[]
  columnMap: SheetColumnMap
}

/** Reads the tab and parses every data row into a `SheetJob`. */
export async function readJobs(
  spreadsheetId: string,
  sheetName: string,
  headerRow: number,
): Promise<SheetReadResult> {
  const values = await readValues(spreadsheetId, sheetName)
  const headerIndex = Math.max(0, headerRow - 1)
  const headers = values[headerIndex] ?? []

  if (!headers.length) {
    throw new SheetsError(
      `Row ${headerRow} of "${sheetName}" is empty, so no column headers could be read.`,
      'NO_HEADERS',
    )
  }

  const columnMap = buildColumnMap(headers)
  const missing = missingRequiredColumns(columnMap)
  if (missing.length) {
    throw new SheetsError(
      `The sheet is missing required column(s): ${missing
        .map((key) => COLUMN_LABELS[key])
        .join(', ')}. Expected headers such as "Job Link" and "Status".`,
      'MISSING_COLUMNS',
    )
  }

  const jobs = parseRows(values, headerIndex, columnMap, `${spreadsheetId}:${sheetName}`)
  return { jobs, headers, columnMap }
}

/**
 * Writes a patch to a single row.
 *
 * Each field becomes its own single-cell range so we never overwrite a column we
 * were not asked to touch, and columns absent from the sheet are skipped rather
 * than guessed at.
 */
export async function updateRow(
  spreadsheetId: string,
  sheetName: string,
  columnMap: SheetColumnMap,
  rowNumber: number,
  patch: SheetJobPatch,
): Promise<{ written: SheetColumnKey[]; skipped: SheetColumnKey[] }> {
  const entries: [SheetColumnKey, string][] = []
  if (patch.status !== undefined) entries.push(['status', patch.status])
  if (patch.appliedDate !== undefined) entries.push(['appliedDate', patch.appliedDate])
  if (patch.resume !== undefined) entries.push(['resume', patch.resume])
  if (patch.other !== undefined) entries.push(['other', patch.other])

  const written: SheetColumnKey[] = []
  const skipped: SheetColumnKey[] = []
  const data: { range: string; values: string[][] }[] = []

  for (const [key, value] of entries) {
    const columnIndex = columnMap[key]
    if (columnIndex === undefined) {
      skipped.push(key)
      continue
    }
    written.push(key)
    const a1 = `${columnLetter(columnIndex)}${rowNumber}`
    data.push({ range: `${quoteSheetName(sheetName)}!${a1}`, values: [[value]] })
  }

  if (!data.length) return { written, skipped }

  const url = `${GOOGLE.sheetsApi}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`
  const response = await googleFetch(url, {
    method: 'POST',
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  })
  await readJson<unknown>(response, 'Updating sheet row')

  return { written, skipped }
}

/**
 * Re-reads one row and confirms it still refers to the job we think it does.
 * Guards against a row being inserted/deleted between opening a job and clicking Done.
 */
export async function verifyRow(
  spreadsheetId: string,
  sheetName: string,
  columnMap: SheetColumnMap,
  rowNumber: number,
  expectedJobLink: string,
): Promise<boolean> {
  const linkIndex = columnMap.jobLink
  if (linkIndex === undefined || !expectedJobLink) return true

  const a1 = `${columnLetter(linkIndex)}${rowNumber}`
  const url = `${GOOGLE.sheetsApi}/${encodeURIComponent(
    spreadsheetId,
  )}/values/${encodeURIComponent(`${quoteSheetName(sheetName)}!${a1}`)}`

  const response = await googleFetch(url)
  const data = await readJson<{ values?: string[][] }>(response, 'Verifying sheet row')
  const actual = (data.values?.[0]?.[0] ?? '').toString().trim()
  return actual === expectedJobLink.trim()
}
