/** Small formatting/parsing helpers shared by the panel and the background worker. */

/** 0-based column index -> A1 column letters (0 -> A, 26 -> AA). */
export function columnLetter(index: number): string {
  let value = index
  let letters = ''
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return letters
}

/** Quotes a sheet/tab name for use in an A1 range. */
export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

/** Accepts a full Google Sheets URL or a bare id and returns the id. */
export function parseSpreadsheetId(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)
  if (match?.[1]) return match[1]
  return trimmed
}

/** Sheet-friendly date, matching the M/D style used in the spec's example sheet. */
export function sheetDate(date: Date = new Date()): string {
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim())
}

export function initialsOf(company: string): string {
  const cleaned = company.trim()
  if (!cleaned) return '?'
  return cleaned[0]!.toUpperCase()
}

export function relativeTime(timestamp: number): string {
  if (!timestamp) return 'never'
  const seconds = Math.round((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Normalises a question/label for alias matching. */
export function normaliseQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[?:.]+$/g, '')
    .trim()
}

function fileSafe(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
}

/**
 * The tailored CV's file name: "{First}_{Last}_CV.pdf" - the name a recruiter sees
 * when it is uploaded. Which job it is for is the folder's name.
 */
export function resumeFileName(owner: string, ext = 'pdf'): string {
  return `${[fileSafe(owner), 'CV'].filter(Boolean).join('_')}.${ext}`
}

/** One folder per application under Downloads/JobApply: "{Company}_{Position}". */
export function jobFolderName(company: string, position: string): string {
  return [fileSafe(company), fileSafe(position)].filter(Boolean).join('_') || 'Unnamed_Job'
}

/** "{First}_{Last}_Cover_Letter.pdf", next to the CV in the application's folder. */
export function coverLetterFileName(owner: string, ext = 'pdf'): string {
  return `${[fileSafe(owner), 'Cover_Letter'].filter(Boolean).join('_')}.${ext}`
}
