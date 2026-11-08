/**
 * Field classification.
 *
 * Turns a scanned field into "this is the applicant's notice period, 0.85
 * confident". Three independent signals are considered and the strongest wins,
 * with a small boost when two agree:
 *
 *   1. the `autocomplete` attribute  - explicit, standardised, near-certain
 *   2. the visible label             - what a human reads
 *   3. the name/id attribute         - what the developer called it
 *
 * Anything that looks like a legal attestation, signature or demographic question
 * is forced into USER_CONFIRMATION_REQUIRED regardless of the other signals. That
 * classification is a floor, not a suggestion: it is what stops the autofill engine
 * from ticking a box that says "I certify the above is true".
 */

import { CANONICAL_FIELD_BY_KEY } from '@/shared/constants/canonical-fields'
import { matchCanonicalField } from '@/storage/answers'
import { normaliseQuestion } from '@/shared/utils/format'
import { resolve } from './locator'
import type { ApplicationField, QuestionCategory } from '@/shared/types/application'

/** HTML autocomplete tokens -> canonical keys. */
const AUTOCOMPLETE_MAP: Record<string, string> = {
  'given-name': 'firstName',
  'additional-name': 'middleName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  'street-address': 'address',
  'address-line1': 'address',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'zip',
  'country-name': 'country',
  country: 'country',
  url: 'portfolio',
  organization: 'currentCompany',
  'organization-title': 'currentTitle',
}

/**
 * Patterns that force USER_CONFIRMATION_REQUIRED even when nothing else matches.
 * Kept broad on purpose - a false positive here just means we ask the user.
 */
const CONFIRMATION_PATTERNS: RegExp[] = [
  /\bi (certify|attest|confirm|acknowledge|agree|authorize|consent)\b/i,
  /\bcertif(y|ication)\b/i,
  /\battest/i,
  /\bconsent\b/i,
  /\bterms (and|&) conditions\b/i,
  /\bprivacy (policy|notice)\b/i,
  /\bsignature\b/i,
  /\bsign here\b/i,
  /\bconflict of interest\b/i,
  /\b(accuracy|truthfulness) of\b/i,
  /\bgender\b|\bsex\b/i,
  /\brace\b|\bethnicit/i,
  /\bhispanic or latino\b/i,
  /\bdisabilit/i,
  /\bveteran\b/i,
  /\bbackground check\b/i,
  /\bdrug (test|screen)/i,
  /\bcriminal\b|\bfelony\b|\bconvict/i,
]

const FILL_THRESHOLD = 0.7

export function classify(field: ApplicationField): ApplicationField {
  const element = resolve(field.id)

  const signals: { key: string; confidence: number }[] = []

  const fromAutocomplete = classifyByAutocomplete(element)
  if (fromAutocomplete) signals.push(fromAutocomplete)

  const fromLabel = matchCanonicalField(field.label)
  if (fromLabel) signals.push({ key: fromLabel.key, confidence: fromLabel.confidence })

  const fromAttributes = classifyByAttributes(element)
  if (fromAttributes) signals.push(fromAttributes)

  const fromInputType = classifyByInputType(field)
  if (fromInputType) signals.push(fromInputType)

  const best = pickBest(signals)

  let canonicalField = best?.key
  let confidence = best?.confidence ?? 0
  let category: QuestionCategory | undefined = canonicalField
    ? CANONICAL_FIELD_BY_KEY.get(canonicalField)?.category
    : undefined

  // The confirmation floor. Applied last so nothing can undo it.
  if (needsUserConfirmation(field)) {
    category = 'USER_CONFIRMATION_REQUIRED'
    // Keep whichever canonical key we found (gender, veteranStatus...) for display,
    // but the category is what governs behaviour.
    if (!canonicalField) canonicalField = undefined
    confidence = Math.max(confidence, 0.9)
  }

  // A long free-text box that maps to nothing is a written answer, not a data field.
  if (!category && field.type === 'textarea') {
    category = 'AI_GENERATED'
    confidence = Math.max(confidence, 0.4)
  }

  const classified: ApplicationField = { ...field, confidence }
  if (canonicalField) classified.canonicalField = canonicalField
  if (category) classified.category = category
  return classified
}

export function classifyAll(fields: ApplicationField[]): ApplicationField[] {
  return fields.map(classify)
}

export function isConfidentEnoughToFill(field: ApplicationField): boolean {
  return (field.confidence ?? 0) >= FILL_THRESHOLD
}

export { FILL_THRESHOLD }

// ---------------------------------------------------------------------------

function pickBest(
  signals: { key: string; confidence: number }[],
): { key: string; confidence: number } | null {
  if (!signals.length) return null

  const sorted = [...signals].sort((a, b) => b.confidence - a.confidence)
  const best = sorted[0]!

  // Independent agreement is meaningful evidence; disagreement is not penalised,
  // because a weak signal losing to a strong one is the normal case.
  const agrees = sorted.slice(1).some((signal) => signal.key === best.key)
  return { key: best.key, confidence: agrees ? Math.min(0.99, best.confidence + 0.1) : best.confidence }
}

function classifyByAutocomplete(element: Element | null): { key: string; confidence: number } | null {
  const raw = element?.getAttribute('autocomplete')
  if (!raw) return null

  // Values can be space-separated sections, e.g. "shipping street-address".
  const token = raw.trim().toLowerCase().split(/\s+/).pop() ?? ''
  const key = AUTOCOMPLETE_MAP[token]
  return key ? { key, confidence: 0.95 } : null
}

function classifyByAttributes(element: Element | null): { key: string; confidence: number } | null {
  if (!element) return null

  const raw = [element.getAttribute('name'), element.id, element.getAttribute('data-automation-id')]
    .filter(Boolean)
    .join(' ')
  if (!raw) return null

  const humanised = raw
    .replace(/[_\-.[\]]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()

  const match = matchCanonicalField(humanised)
  if (!match) return null

  // Attribute names are developer shorthand, so trust them slightly less than a label.
  return { key: match.key, confidence: match.confidence * 0.9 }
}

function classifyByInputType(field: ApplicationField): { key: string; confidence: number } | null {
  if (field.type === 'email') return { key: 'email', confidence: 0.8 }
  if (field.type === 'tel') return { key: 'phone', confidence: 0.8 }
  return null
}

function needsUserConfirmation(field: ApplicationField): boolean {
  const haystack = normaliseQuestion(field.label)
  if (!haystack) return false
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(haystack))
}
