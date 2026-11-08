/**
 * Page identity comparison (spec section 17).
 *
 * Pure, so the content script's watcher, the background's step tracker and the
 * check script all agree on what "the page changed" means.
 *
 * URL changes alone are not trusted - many application flows are single-page apps
 * that never touch the URL, and others rewrite it without changing the step. The
 * set of questions on the page is the primary signal; URL and heading break ties.
 */

import type { PageChange, PageFingerprint, StepRecord } from '../types/application'

/** Below this share of common questions, it is a different page whatever else matches. */
const NEW_PAGE_BELOW = 0.5
/** Below this, a changed URL or heading is enough to call it a different page. */
const SAME_PAGE_FROM = 0.8

/** Multiset Jaccard similarity of two pages' questions, 0-1. */
export function fieldSimilarity(a: PageFingerprint, b: PageFingerprint): number {
  if (!a.fieldKeys.length && !b.fieldKeys.length) return 1

  const counts = new Map<string, [number, number]>()
  for (const key of a.fieldKeys) {
    const entry = counts.get(key) ?? [0, 0]
    entry[0] += 1
    counts.set(key, entry)
  }
  for (const key of b.fieldKeys) {
    const entry = counts.get(key) ?? [0, 0]
    entry[1] += 1
    counts.set(key, entry)
  }

  let shared = 0
  let total = 0
  for (const [left, right] of counts.values()) {
    shared += Math.min(left, right)
    total += Math.max(left, right)
  }
  return total ? shared / total : 1
}

export function comparePages(previous: PageFingerprint, next: PageFingerprint): PageChange {
  const sameUrl = previous.url === next.url
  const sameHeading = previous.heading === next.heading

  // Neither page has questions (a job posting, an interstitial): only URL/heading tell them apart.
  if (!previous.fieldKeys.length && !next.fieldKeys.length) {
    return sameUrl && sameHeading ? 'same' : 'new-page'
  }
  // Questions appearing from nothing, or vanishing entirely, is a step change.
  if (!previous.fieldKeys.length || !next.fieldKeys.length) return 'new-page'

  const similarity = fieldSimilarity(previous, next)

  if (similarity === 1) {
    // Identical questions under a new heading or URL: a repeated section such as
    // "Work experience 1" -> "Work experience 2".
    return sameUrl && sameHeading ? 'same' : 'new-page'
  }
  if (similarity < NEW_PAGE_BELOW) return 'new-page'
  if ((!sameUrl || !sameHeading) && similarity < SAME_PAGE_FROM) return 'new-page'
  return 'modified'
}

/**
 * Finds the already-seen step a page corresponds to, if any. Used to recognise a
 * Back navigation instead of counting it as a new step.
 */
export function findMatchingStep(
  steps: readonly StepRecord[],
  page: PageFingerprint,
): StepRecord | null {
  let best: StepRecord | null = null
  let bestScore = -1
  for (const step of steps) {
    if (comparePages(step.page, page) === 'new-page') continue
    const score = fieldSimilarity(step.page, page)
    if (score > bestScore) {
      best = step
      bestScore = score
    }
  }
  return best
}

/** Strips the query string, which churns on tracking parameters without changing the page. */
export function pageUrl(href: string): string {
  try {
    const url = new URL(href)
    return `${url.origin}${url.pathname}${url.hash}`
  } catch {
    return href
  }
}
