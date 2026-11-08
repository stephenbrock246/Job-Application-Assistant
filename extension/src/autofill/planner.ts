/**
 * The autofill decision layer (spec section 16).
 *
 * Pure: takes scanned fields plus what we know about the applicant, and returns a
 * plan. It touches no DOM and no storage, so the rules below are the whole policy
 * and can be reasoned about in one place.
 *
 * The rules, in priority order:
 *   1. Never write to a USER_CONFIRMATION_REQUIRED field. No exceptions, no
 *      confidence override. These always go back to the user.
 *   2. Never overwrite a value that is already there - the site may have prefilled
 *      it, or the user may have typed it.
 *   3. Never fill below the confidence threshold. An unsure guess on an application
 *      form is worse than an empty box, because the user will not notice it.
 *   4. A saved answer beats the profile, because the user set it deliberately.
 *   5. Required and unknown -> ask. Optional and unknown -> leave it, but report it.
 */

import { FILL_THRESHOLD } from '@/content/scanner/field-classifier'
import { VOLUNTARY_KEYS, isAutoFillable } from '@/shared/constants/canonical-fields'
import { readCanonicalValue } from '@/storage/applicant-profile'
import type { ApplicationField, FieldPlan, FillInstruction } from '@/shared/types/application'
import type { ApplicantProfile } from '@/shared/types/profile'
import type { SavedAnswer } from '@/shared/types/application'

export interface PlanResult {
  plans: FieldPlan[]
  instructions: FillInstruction[]
  ask: FieldPlan[]
  skipped: FieldPlan[]
}

export function planAutofill(
  fields: ApplicationField[],
  profile: ApplicantProfile,
  savedAnswers: SavedAnswer[],
): PlanResult {
  const answerByKey = new Map(savedAnswers.map((answer) => [answer.key, answer]))
  const plans = fields.map((field) => planField(field, profile, answerByKey))

  return {
    plans,
    instructions: plans
      .filter((plan) => plan.decision === 'fill' && plan.value !== undefined)
      .map((plan) => ({
        fieldId: plan.field.id,
        value: plan.value!,
        source: plan.source ?? 'profile',
        ...(plan.field.canonicalField ? { canonicalField: plan.field.canonicalField } : {}),
        ...(plan.field.widget ? { widget: plan.field.widget } : {}),
      })),
    ask: plans.filter((plan) => plan.decision === 'ask'),
    skipped: plans.filter((plan) => plan.decision === 'skip'),
  }
}

function planField(
  field: ApplicationField,
  profile: ApplicantProfile,
  answerByKey: Map<string, SavedAnswer>,
): FieldPlan {
  // Rule 1 - the confirmation floor.
  // The one exception: a voluntary self-identification choice the user has
  // explicitly answered in their profile. Only choice controls (an option must
  // match their words exactly enough for the filler), never free text, and never
  // legal attestations or signatures - those are not voluntary keys.
  if (field.category === 'USER_CONFIRMATION_REQUIRED') {
    const key = field.canonicalField
    const own = key && VOLUNTARY_KEYS.has(key) ? readCanonicalValue(profile, key) : ''
    const isChoice = field.type === 'radio' || field.type === 'select'
    if (own && isChoice && !field.value && !field.valueUnknown) {
      return { field, decision: 'fill', value: own, source: 'profile' }
    }
  }
  if (field.category === 'USER_CONFIRMATION_REQUIRED') {
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'NEEDS_USER',
      reason:
        field.canonicalField && VOLUNTARY_KEYS.has(field.canonicalField)
          ? 'Voluntary question - answer it on the page, or set your own answer in Settings > Profile > Voluntary self-identification.'
          : 'Legal declarations and signatures are never answered for you.',
    }
  }

  // Rule 2 - do not clobber existing content.
  if (field.value) {
    return {
      field,
      decision: 'skip',
      reasonCode: 'ALREADY_FILLED',
      reason: 'Already has a value.',
    }
  }

  if (field.type === 'file') {
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'FILE_UPLOAD',
      reason: 'File upload - your approved resume / cover letter is attached automatically, or press Attach.',
    }
  }

  // A site-built control the extension knows how to operate (option buttons, ARIA
  // radios, dropdowns, type-and-pick boxes) goes through the normal rules below and
  // is filled by clicking its option. One it does not understand is listed, never
  // written to - guessing at an unknown control is how wrong answers get submitted.
  // The saved answer is shown so the user can pick it in one click.
  if (field.custom && (!field.widget || field.valueUnknown)) {
    const key = field.canonicalField
    const saved = key ? answerByKey.get(key)?.value || readCanonicalValue(profile, key) : ''
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'NEEDS_USER',
      reason: field.valueUnknown
        ? 'Marked required, but the extension cannot read this control - check it on the page.'
        : `Site-built ${field.type === 'radio' ? 'choice' : 'dropdown'} - choose it on the page.${
            saved ? ` Your saved answer: ${saved}.` : ''
          }`,
    }
  }

  // Written answers are drafted on request and always reviewed; never filled silently.
  if (field.category === 'AI_GENERATED') {
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'AI_REQUIRED',
      reason:
        field.canonicalField === 'coverLetter'
          ? 'Cover letter - generate it in the Cover letter section, or insert the one you have.'
          : 'Written answer - draft it with AI below, then review and edit before it is filled.',
    }
  }

  const key = field.canonicalField
  if (!key || !isAutoFillable(field.category)) {
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'UNMAPPED',
      reason: 'Could not tell what this field is asking for.',
    }
  }

  // Rule 3 - confidence gate.
  if ((field.confidence ?? 0) < FILL_THRESHOLD) {
    return {
      field,
      decision: field.required ? 'ask' : 'skip',
      reasonCode: 'LOW_CONFIDENCE',
      reason: `Not confident enough that this is "${key}" (${Math.round((field.confidence ?? 0) * 100)}%).`,
    }
  }

  // Rule 4 - saved answer wins over the profile.
  const saved = answerByKey.get(key)
  if (saved?.value) {
    if (!saved.autoFill) {
      return {
        field,
        decision: 'ask',
        value: saved.value,
        reasonCode: 'NEEDS_USER',
        reason: 'You asked to confirm this answer each time.',
      }
    }
    return { field, decision: 'fill', value: saved.value, source: 'saved-answer' }
  }

  const fromProfile = readCanonicalValue(profile, key)
  if (fromProfile) {
    return { field, decision: 'fill', value: fromProfile, source: 'profile' }
  }

  // Rule 5 - unknown.
  return {
    field,
    decision: field.required ? 'ask' : 'skip',
    reasonCode: 'NO_VALUE',
    reason: 'No saved value for this yet.',
  }
}
