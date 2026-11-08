/**
 * Next / Continue / Submit detection and clicking (spec section 18).
 *
 * Clicking is only half of the loop. The caller must then wait for and verify a
 * page change (page-watcher.ts); a click on its own is never treated as progress.
 *
 * `clickNext` never clicks a final submit, whatever calls it. The label check is
 * applied at click time, not only at detection time, so no caller can route around
 * it. The one way to submit is `clickApprovedSubmit`, which the worker calls only
 * after the user pressed Submit for that application.
 */

import type { NextControlKind } from '@/shared/types/application'

const ADVANCE_PATTERNS: { pattern: RegExp; kind: NextControlKind }[] = [
  { pattern: /^(next|next step|continue|proceed|save (and|&) continue|save (and|&) next)$/i, kind: 'next' },
  { pattern: /^(review|continue to review|review application)$/i, kind: 'next' },
  {
    pattern: /^(submit|submit application|send application|apply|apply now|finish|review (and|&) submit)$/i,
    kind: 'submit',
  },
]

/** Wording that means "this sends the application". Checked again right before any click. */
const FINAL_SUBMIT = /\b(submit|apply|send|finish|complete application)\b/i

export function isFinalSubmitLabel(label: string): boolean {
  return FINAL_SUBMIT.test(label)
}

export interface NextControl {
  label: string
  kind: NextControlKind
  element: HTMLElement
}

export type ClickResult =
  | { clicked: true; label: string }
  | { clicked: false; reason: 'NO_CONTROL' | 'SUBMIT_REFUSED'; label?: string }

/**
 * Clicks the page's Next/Continue control. Refuses a final submit.
 *
 * The click is deferred a tick so the caller's response can leave the page before
 * a full navigation tears the content script down.
 */
export function clickNext(): ClickResult {
  const control = findNextControl()
  if (!control) return { clicked: false, reason: 'NO_CONTROL' }
  if (control.kind === 'submit' || isFinalSubmitLabel(control.label)) {
    return { clicked: false, reason: 'SUBMIT_REFUSED', label: control.label }
  }

  const { element } = control
  setTimeout(() => {
    element.scrollIntoView?.({ block: 'center' })
    element.click()
  }, 30)
  return { clicked: true, label: control.label }
}

/**
 * Submits the application. Only for a submit the user approved: the worker sends
 * this solely from the approval flow. Clicks only a control that really is a
 * final submit; anything else is left alone.
 */
export function clickApprovedSubmit(): ClickResult {
  const control = findNextControl()
  if (!control || !(control.kind === 'submit' || isFinalSubmitLabel(control.label))) {
    return { clicked: false, reason: 'NO_CONTROL' }
  }
  const { element } = control
  setTimeout(() => {
    element.scrollIntoView?.({ block: 'center' })
    element.click()
  }, 30)
  return { clicked: true, label: control.label }
}

/** The way from a job posting into its application form. */
const FORM_ENTRY =
  /^(apply|apply now|apply here|apply online|apply for (this |the )?(job|position|role)|apply to (this |the )?(job|position|role)|apply on company (site|website)|i['’]?m interested|i am interested|start (your |my )?application|begin application|application)$/i

/**
 * Clicks "Apply" (or the "Application" tab) on a posting page. The caller has
 * checked that the page holds no form yet, so this cannot be a final submit.
 */
export function clickApplyEntry(): { clicked: boolean; label?: string } {
  const entry = findApplyEntry()
  if (!entry) return { clicked: false }
  // A link that would open a new window: follow it here, in the job tab, instead.
  if (entry instanceof HTMLAnchorElement && entry.target === '_blank' && /^https?:/i.test(entry.href)) {
    const href = entry.href
    setTimeout(() => location.assign(href), 30)
    return { clicked: true, label: controlLabel(entry) }
  }
  setTimeout(() => {
    entry.scrollIntoView?.({ block: 'center' })
    entry.click()
  }, 30)
  return { clicked: true, label: controlLabel(entry) }
}

/** The posting's "Apply" / "I'm interested" control, if the page shows one. */
export function findApplyEntry(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('a, button, input[type="button"], input[type="submit"], [role="button"], [role="tab"]'),
  )
  return (
    candidates.find((element) => {
      if (isDisabled(element) || !isVisible(element)) return false
      const label = controlLabel(element)
      return label.length <= 40 && FORM_ENTRY.test(label)
    }) ?? null
  )
}

export function applyEntryLabel(): string | null {
  const entry = findApplyEntry()
  return entry ? controlLabel(entry) : null
}

export function findNextControl(): NextControl | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]',
    ),
  )

  let fallback: NextControl | null = null

  for (const element of candidates) {
    if (isDisabled(element) || !isVisible(element)) continue

    const label = controlLabel(element)
    if (!label || label.length > 40) continue

    for (const { pattern, kind } of ADVANCE_PATTERNS) {
      if (!pattern.test(label)) continue
      // A "next" control is more useful to report than a final "submit".
      if (kind === 'next') return { label, kind, element }
      fallback ??= { label, kind, element }
    }
  }

  return fallback
}

function controlLabel(element: HTMLElement): string {
  if (element instanceof HTMLInputElement) return element.value.trim()
  const aria = element.getAttribute('aria-label')
  if (aria?.trim()) return aria.replace(/\s+/g, ' ').trim()
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function isDisabled(element: HTMLElement): boolean {
  if ((element as HTMLButtonElement).disabled) return true
  return element.getAttribute('aria-disabled') === 'true'
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}
