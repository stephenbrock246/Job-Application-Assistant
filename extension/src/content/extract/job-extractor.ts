/**
 * Generic job-description extraction.
 *
 * Strategy order, best first:
 *   1. schema.org JobPosting JSON-LD - structured, and used by most ATS platforms.
 *   2. Known container selectors (Greenhouse/Lever/Ashby/Workday/LinkedIn markup).
 *   3. Largest dense text block on the page.
 *
 * Each strategy reports its own confidence so the side panel can tell the user
 * "we are not sure this is the job description" rather than quietly tailoring a
 * resume against navigation chrome.
 */

import type { JobInfo } from '@/shared/types/job'

interface Candidate {
  description: string
  title: string
  company: string
  location: string
  source: string
  confidence: number
}

const DESCRIPTION_SELECTORS = [
  '#content .job__description',
  '[data-testid="jobDescriptionText"]',
  '[data-automation-id="jobPostingDescription"]',
  '.job-details-jobs-unified-top-card__job-description',
  '.jobs-description__content',
  '#job-details',
  '.job-description',
  '#job_description',
  '[class*="jobDescription"]',
  '[class*="job-description"]',
  '[class*="posting-description"]',
  '.content-intro',
  'section[aria-label*="description" i]',
  'article',
  'main',
]

export function extractJob(): JobInfo {
  const candidates = [fromJsonLd(), fromSelectors(), fromLargestBlock()].filter(
    (c): c is Candidate => c !== null,
  )

  const best = candidates.sort((a, b) => b.confidence - a.confidence)[0]

  return {
    url: location.href,
    title: best?.title || documentTitleGuess(),
    company: best?.company || companyGuess(),
    location: best?.location ?? '',
    description: best?.description ?? '',
    source: best?.source ?? 'none',
    confidence: best?.confidence ?? 0,
    extractedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------

function fromJsonLd(): Candidate | null {
  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  )

  for (const script of scripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(script.textContent ?? '')
    } catch {
      continue
    }

    for (const node of flattenJsonLd(parsed)) {
      if (!isJobPosting(node)) continue

      const description = htmlToText(String(node.description ?? ''))
      if (description.length < 80) continue

      return {
        description,
        title: String(node.title ?? ''),
        company: readOrgName(node.hiringOrganization),
        location: readLocation(node.jobLocation),
        source: 'jsonld:JobPosting',
        confidence: 0.95,
      }
    }
  }
  return null
}

function fromSelectors(): Candidate | null {
  for (const selector of DESCRIPTION_SELECTORS) {
    const element = document.querySelector<HTMLElement>(selector)
    if (!element) continue

    const text = normaliseText(element.innerText ?? '')
    if (text.length < 200) continue

    // `main`/`article` are last-resort containers, so trust them less.
    const generic = selector === 'main' || selector === 'article'
    return {
      description: text,
      title: documentTitleGuess(),
      company: companyGuess(),
      location: '',
      source: `selector:${selector}`,
      confidence: generic ? 0.5 : 0.8,
    }
  }
  return null
}

function fromLargestBlock(): Candidate | null {
  const blocks = Array.from(document.querySelectorAll<HTMLElement>('div, section, td'))
  let best: { element: HTMLElement; score: number } | null = null

  for (const element of blocks) {
    // Skip containers that merely wrap other containers.
    if (element.querySelectorAll('div, section').length > 40) continue

    const text = element.innerText ?? ''
    if (text.length < 400) continue

    const linkText = Array.from(element.querySelectorAll('a'))
      .map((a) => a.innerText.length)
      .reduce((sum, n) => sum + n, 0)

    // Dense prose scores well; link-heavy navigation does not.
    const score = text.length * (1 - Math.min(linkText / text.length, 1))
    if (!best || score > best.score) best = { element, score }
  }

  if (!best) return null
  return {
    description: normaliseText(best.element.innerText),
    title: documentTitleGuess(),
    company: companyGuess(),
    location: '',
    source: 'heuristic:largest-text-block',
    confidence: 0.35,
  }
}

// ---------------------------------------------------------------------------

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd)
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>
    const nested = Array.isArray(node['@graph']) ? flattenJsonLd(node['@graph']) : []
    return [node, ...nested]
  }
  return []
}

function isJobPosting(node: Record<string, unknown>): boolean {
  const type = node['@type']
  if (typeof type === 'string') return type === 'JobPosting'
  if (Array.isArray(type)) return type.includes('JobPosting')
  return false
}

function readOrgName(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name
    if (typeof name === 'string') return name
  }
  return ''
}

function readLocation(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value
  if (!first || typeof first !== 'object') return ''

  const address = (first as Record<string, unknown>).address
  if (typeof address === 'string') return address
  if (address && typeof address === 'object') {
    const a = address as Record<string, unknown>
    return [a.addressLocality, a.addressRegion, a.addressCountry]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(', ')
  }
  return ''
}

/**
 * Plain text from a description that may be HTML - or HTML escaped once more
 * ("&lt;p&gt;We are...", as some boards put it in JSON-LD). Parsed with DOMParser,
 * which builds an inert document: nothing in it loads or runs.
 */
function htmlToText(html: string): string {
  let text = html
  for (let round = 0; round < 2; round += 1) {
    if (!/<[a-z!/][\s\S]*>/i.test(text) && !/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i.test(text)) break
    text = new DOMParser().parseFromString(text, 'text/html').body.textContent ?? ''
  }
  return normaliseText(text)
}

function normaliseText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function documentTitleGuess(): string {
  const heading = document.querySelector<HTMLElement>('h1')
  const fromHeading = heading?.innerText?.trim()
  if (fromHeading && fromHeading.length < 140) return fromHeading

  // Page titles are usually "Job Title - Company | Board".
  return (document.title.split(/[|–—]/)[0] ?? document.title).trim()
}

function companyGuess(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[property="og:site_name"]')
  if (meta?.content) return meta.content.trim()

  const parts = document.title.split(/\s[-|–—]\s/)
  if (parts.length > 1) return (parts[1] ?? '').trim()
  return ''
}
