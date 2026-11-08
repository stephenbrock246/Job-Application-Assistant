/** Google Sheets configuration and column mapping (spec section 21). */

/** Canonical column keys. Resolution is by *header name*, never by column letter. */
export type SheetColumnKey =
  | 'date'
  | 'jobLink'
  | 'company'
  | 'position'
  | 'status'
  | 'other'
  | 'appliedDate'
  | 'resume'

/** Maps a canonical column key to its 0-based column index in the sheet. */
export type SheetColumnMap = Partial<Record<SheetColumnKey, number>>

export interface SheetConfig {
  spreadsheetId: string
  /** Tab name, e.g. "Sheet1". */
  sheetName: string
  /** 1-based row that holds the headers. Data starts on the next row. */
  headerRow: number
  /** Cached spreadsheet title, for display only. */
  spreadsheetTitle?: string
  /** Resolved at connect time and cached so we do not re-read headers on every poll. */
  columnMap?: SheetColumnMap
  /** Headers exactly as found, for the settings UI to show what was matched. */
  detectedHeaders?: string[]
}

export interface SheetTab {
  title: string
  sheetId: number
  index: number
}

export interface SheetConnectionInfo {
  spreadsheetTitle: string
  tabs: SheetTab[]
}
