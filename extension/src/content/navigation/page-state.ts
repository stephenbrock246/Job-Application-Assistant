/**
 * What the current page is, and whether it is busy (spec section 17).
 *
 * The fingerprint is built from the same scanner the autofill uses, so "a new page"
 * means "a new set of questions" in exactly the sense the rest of the extension
 * understands fields.
 */

import { scanFields } from '../scanner/form-scanner'
import { pageUrl } from '@/shared/utils/page-compare'
import type { ApplicationField, PageFingerprint } from '@/shared/types/application'

export function capturePage(fields: ApplicationField[] = scanFields()): PageFingerprint {
  return {
    url: pageUrl(location.href),
    heading: currentHeading(),
    fieldKeys: fields.map(fieldKey).sort(),
    takenAt: Date.now(),
  }
}

function fieldKey(field: ApplicationField): string {
  const label = field.label
    .toLowerCase()
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
  return `${field.type}:${label}`
}

/**
 * The step's own title. An explicit step indicator wins; otherwise the first
 * visible heading inside the form area. The page-wide h1 is usually the job title,
 * which is identical on every step, so it only counts when nothing else exists.
 */
function currentHeading(): string {
  const parts: string[] = []

  const indicator = firstVisible('[aria-current="step"], [data-automation-id="progressBarActiveStep"]')
  if (indicator) parts.push(text(indicator))

  const scope = document.querySelector('form') ?? document.querySelector('main, [role="main"]')
  const heading =
    (scope && firstVisible('h1, h2, h3', scope)) ?? firstVisible('h1')
  if (heading) parts.push(text(heading))

  return parts
    .filter(Boolean)
    .join(' / ')
    .slice(0, 160)
}

const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  // A progressbar with a value is a step indicator, not a spinner.
  '[role="progressbar"]:not([aria-valuenow])',
  '[class*="spinner" i]',
  '[class*="loading-indicator" i]',
  '[data-automation-id*="loading" i]',
].join(', ')

/** True while the page shows a visible busy indicator. */
export function isLoading(): boolean {
  for (const element of document.querySelectorAll<HTMLElement>(LOADING_SELECTORS)) {
    if (isVisible(element)) return true
  }
  return false
}

/** Hosts of applicant-tracking systems that are commonly embedded in company career pages. */
const ATS_HOSTS =
  /greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|icims\.com|smartrecruiters\.com|jobvite\.com|bamboohr\.com|recruitee\.com|workable\.com|jazzhr\.com|applytojob\.com|breezy\.hr|teamtailor\.com|personio\.|jobdiva\.com|taleo\.net|successfactors\./i

/**
 * Application forms shown in an <iframe> from another site. A page scan cannot
 * read inside them (browsers keep other sites' frames separate), so they are
 * reported and the panel offers to open the form directly.
 */
export function embeddedForms(): string[] {
  const found: string[] = []
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
    let url: URL
    try {
      url = new URL(frame.src, location.href)
    } catch {
      continue
    }
    if (url.host === location.host || !/^https?:$/.test(url.protocol)) continue
    const rect = frame.getBoundingClientRect()
    const large = rect.width >= 300 && rect.height >= 300
    if ((ATS_HOSTS.test(url.host) && rect.width > 0) || (large && /apply|job|career|application/i.test(url.href))) {
      found.push(url.href)
    }
  }
  return [...new Set(found)]
}

const CONFIRMATION_PATTERN =
  /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(successfully )?(submitted|received)|we('ve| have) received your application|your application is complete/i

/**
 * A "thank you for applying" screen. Only ever used to *prompt* the user to press
 * Done - it never records an outcome, because a page's wording is not proof.
 */
export function looksLikeConfirmation(fieldCount: number): boolean {
  if (fieldCount > 2) return false
  const body = (document.body?.innerText ?? document.body?.textContent ?? '').slice(0, 20_000)
  return CONFIRMATION_PATTERN.test(body)
}

function firstVisible(selector: string, root: ParentNode = document): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (isVisible(element) && text(element)) return element
  }
  return null
}

function text(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}
