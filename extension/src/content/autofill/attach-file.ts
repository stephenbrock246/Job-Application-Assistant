/**
 * Attaching a generated file to an upload field.
 *
 * Two ways in, tried in order:
 *   1. Set the input's FileList through a DataTransfer (the only way a script can)
 *      and fire input/change - what ordinary and React upload fields listen to.
 *   2. Only if the page plainly ignored that: a synthetic drag-and-drop onto the
 *      drop zone around the input, for zones that only react to `drop`.
 *
 * Success is judged from the page, never from the absence of an error: the file
 * name appears, an upload starts, or the site took the file off the input (it read
 * it). The second way is never tried after any of those signs - that is what keeps
 * a slow-to-render upload from being sent twice.
 */

import { resolve } from '../scanner/locator'
import { isLoading } from '../navigation/page-state'

export interface AttachResult {
  attached: boolean
  error?: string
}

const SETTLE_MS = 1_500
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

export async function attachFile(fieldId: string, fileName: string, mime: string, base64: string): Promise<AttachResult> {
  const element = resolve(fieldId)
  if (!(element instanceof HTMLInputElement) || element.type !== 'file') {
    return { attached: false, error: 'The upload field is no longer on the page.' }
  }

  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const makeTransfer = () => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], fileName, { type: mime, lastModified: Date.now() }))
    return transfer
  }

  // What the page shows before: an earlier upload of the same name (or of a file
  // whose name starts the same) must not count as this one.
  const before = mentions(fileName)
  const errorsBefore = nearbyError(element)

  // 1. The input itself.
  try {
    element.files = makeTransfer().files
  } catch (error) {
    return { attached: false, error: error instanceof Error ? error.message : 'The page refused the file.' }
  }
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  await sleep(SETTLE_MS)

  if (shownNow(fileName, before) || isLoading()) return { attached: true }
  // The site read the file and cleared the input: accepted - unless it said why it refused it.
  if (element.isConnected && element.files?.[0]?.name !== fileName) {
    const refusal = nearbyError(element)
    if (refusal && refusal !== errorsBefore) return { attached: false, error: `The page refused the file: ${refusal}` }
    return { attached: true }
  }

  // 2. The page ignored the input. Drop onto its zone, once.
  const zone = dropZone(element)
  if (zone) {
    const transfer = makeTransfer()
    for (const type of ['dragenter', 'dragover', 'drop'] as const) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    await sleep(SETTLE_MS)
    if (shownNow(fileName, before) || isLoading()) return { attached: true }
  }

  // Held by the input but not shown: most forms still submit it, but say so honestly.
  return element.files?.[0]?.name === fileName
    ? { attached: true, error: 'Attached, but the page does not show it - check the upload box before submitting.' }
    : { attached: false, error: 'The page did not take the file. Attach it by hand.' }
}

/** How often the page shows the file's full name, and its shortened form (widgets cut long names). */
function mentions(fileName: string): { full: number; short: number } {
  const text = document.body?.innerText ?? document.body?.textContent ?? ''
  const count = (needle: string) => (needle ? text.split(needle).length - 1 : 0)
  return { full: count(fileName), short: fileName.length > 24 ? count(fileName.slice(0, 24)) : 0 }
}

/** The name newly appeared on the page since `before`. */
function shownNow(fileName: string, before: { full: number; short: number }): boolean {
  const after = mentions(fileName)
  return after.full > before.full || after.short > before.short
}

/** An error message shown around the upload field ("File type not supported", "Too large"). */
function nearbyError(input: HTMLElement): string {
  let container: HTMLElement | null = input.parentElement
  for (let depth = 0; container && depth < 4; depth += 1) {
    const text = (container.innerText ?? container.textContent ?? '').replace(/\s+/g, ' ')
    const match = /[^.]*\b(not supported|unsupported|invalid file|too large|exceeds|failed to upload|upload failed|error)\b[^.]*/i.exec(text)
    if (match) return match[0].trim().slice(0, 160)
    container = container.parentElement
  }
  return ''
}

/** The nearest container that presents itself as a drop target. */
function dropZone(input: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = input.parentElement
  for (let depth = 0; current && depth < 5; depth += 1) {
    const marker = `${current.className} ${current.getAttribute('data-testid') ?? ''}`
    if (/drop|upload/i.test(marker) || /drag\s*(and|&)\s*drop|drop\s+(a\s+)?file/i.test(current.textContent ?? '')) {
      return current
    }
    current = current.parentElement
  }
  return null
}
