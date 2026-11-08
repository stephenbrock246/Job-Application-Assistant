/**
 * CSV reading and writing (RFC 4180, plus the usual real-world deviations).
 *
 * Handled because job spreadsheets exported from Excel, Google Sheets and Notion
 * all differ: UTF-8 BOM, CRLF or LF, semicolon or tab delimiters in non-US locales,
 * quoted fields containing commas and newlines, and doubled quotes as escapes.
 *
 * The parser is lossless about structure: it returns every record, including any
 * preamble rows above the header, so writing the file back preserves what was
 * there rather than reformatting the user's document.
 */

export type Eol = '\r\n' | '\n'

export interface ParsedCsv {
  records: string[][]
  delimiter: string
  eol: Eol
  hadBom: boolean
}

const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'] as const

export function parseCsv(input: string, forcedDelimiter?: string): ParsedCsv {
  const hadBom = input.charCodeAt(0) === 0xfeff
  const text = hadBom ? input.slice(1) : input

  const eol: Eol = text.includes('\r\n') ? '\r\n' : '\n'
  const delimiter = forcedDelimiter ?? sniffDelimiter(text)

  return { records: parseRecords(text, delimiter), delimiter, eol, hadBom }
}

/**
 * Picks the delimiter that yields the most consistent column count across the
 * first few lines. Counting occurrences alone is fooled by a single prose cell
 * full of commas; consistency is the signal that actually distinguishes them.
 */
function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 10)
  if (!sample.length) return ','

  let best = ','
  let bestScore = -1

  for (const candidate of CANDIDATE_DELIMITERS) {
    const counts = sample.map((line) => countOutsideQuotes(line, candidate))
    const max = Math.max(...counts)
    if (max === 0) continue

    const modal = counts.filter((count) => count === max).length
    // Reward "every line has the same number of separators", then column count.
    const score = modal * 100 + max
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1
      else inQuotes = !inQuotes
    } else if (char === delimiter && !inQuotes) {
      count += 1
    }
  }
  return count
}

function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let inQuotes = false
  let sawAnyContent = false

  const endField = () => {
    record.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    records.push(record)
    record = []
    sawAnyContent = false
  }

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      sawAnyContent = true
      continue
    }

    if (char === '"' && field === '') {
      inQuotes = true
      sawAnyContent = true
      continue
    }

    if (char === delimiter) {
      endField()
      sawAnyContent = true
      continue
    }

    if (char === '\r') {
      // Consume CRLF as one terminator; a lone CR also ends the record.
      if (text[i + 1] === '\n') i += 1
      endRecord()
      continue
    }

    if (char === '\n') {
      endRecord()
      continue
    }

    field += char
    sawAnyContent = true
  }

  // A trailing newline should not produce a phantom empty record.
  if (field !== '' || record.length > 0 || sawAnyContent) endRecord()

  return records
}

export function serializeCsv(records: string[][], delimiter = ',', eol: Eol = '\r\n', bom = false): string {
  const body = records
    .map((record) => record.map((field) => quoteField(field, delimiter)).join(delimiter))
    .join(eol)
  // A trailing newline is what every other tool writes.
  return `${bom ? '﻿' : ''}${body}${body ? eol : ''}`
}

function quoteField(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes('"') ||
    value.includes(delimiter) ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim()

  if (!needsQuotes) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** Pads every record to the same width, so column writes never fall off the end. */
export function normaliseWidth(records: string[][], width: number): string[][] {
  return records.map((record) => {
    if (record.length >= width) return record
    return [...record, ...Array<string>(width - record.length).fill('')]
  })
}
