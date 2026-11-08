/**
 * Getting from a job page to its application form - the decision, one look at a time.
 *
 * Order matters:
 *  1. An application form embedded from a hiring site (Greenhouse, Lever, Ashby...
 *     in a frame on a company's careers page) is the real form, even when the page
 *     has small forms of its own (a job alert, a newsletter). The extension cannot
 *     reach into the frame, so it opens the form in the tab itself.
 *  2. An upload field or several questions: this page is the form.
 *  3. An "Apply" / "I'm interested" button: press it (once).
 *  4. A couple of fields, no button, no embedded form, after a moment: a small form.
 */

import { MIN_FIRST_STEP_FIELDS } from './step-tracker'

export interface EnterLook {
  fields: { type: string }[]
  embeddedForms: string[]
  /** Label of the page's Apply button, if it shows one. */
  applyEntry: string | null
}

export interface EnterState {
  elapsedMs: number
  /** Embedded forms already opened, Apply buttons already pressed - each only once. */
  opened: ReadonlySet<string>
  pressed: ReadonlySet<string>
}

export type EnterAction =
  | { kind: 'entered' }
  | { kind: 'open'; url: string }
  | { kind: 'press'; label: string }
  | { kind: 'wait' }

export function nextEnterAction(look: EnterLook, state: EnterState): EnterAction {
  const hasUpload = look.fields.some((field) => field.type === 'file')
  const embedded = look.embeddedForms.find((url) => !state.opened.has(url))
  if (embedded && !hasUpload) return { kind: 'open', url: embedded }
  if (hasUpload || look.fields.length >= 4) return { kind: 'entered' }
  if (look.applyEntry && !state.pressed.has(look.applyEntry) && state.elapsedMs > 1_500) {
    return { kind: 'press', label: look.applyEntry }
  }
  if (look.fields.length >= MIN_FIRST_STEP_FIELDS && !look.applyEntry && !look.embeddedForms.length && state.elapsedMs > 3_000) {
    return { kind: 'entered' }
  }
  return { kind: 'wait' }
}
