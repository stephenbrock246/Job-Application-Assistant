/**
 * The safety check before a final submit.
 *
 * Run on the last page once everything has been filled, and again right before
 * the approved submit (the page may have changed while it waited). "blocking"
 * means only the user can finish it; "notes" are worth a look but do not stop
 * the approval request.
 */

import type { ApplicationField, ApplicationSession, AutofillReport } from '../types/application'

export interface PreSubmitResult {
  blocking: string[]
  notes: string[]
}

export function isCoverLetterUpload(label: string): boolean {
  return /cover\s*letter|motivation(al)? letter/i.test(label)
}

export function isResumeUpload(label: string): boolean {
  return !isCoverLetterUpload(label) && /r[eé]sum[eé]|\bcv\b|curriculum/i.test(label)
}

export function preSubmitCheck(session: ApplicationSession, report: AutofillReport): PreSubmitResult {
  const blocking: string[] = []
  const notes: string[] = []
  const fields: ApplicationField[] = report.fields ?? []
  const label = (field: ApplicationField) => field.label.replace(/\s*\*\s*$/, '').trim() || 'an unnamed field'

  // Some sites read an uploaded file and then clear their input, so the page alone
  // can look empty; a successful upload of that field on this page counts too.
  const attached = session.autopilot?.attached ?? {}
  const hasValue = (field: ApplicationField) =>
    Boolean(field.value) || (field.type === 'file' && Boolean(attached[`${field.id}@${report.url}`]?.ok))

  for (const field of fields) {
    if (!field.required || hasValue(field)) continue
    if (field.valueUnknown) {
      notes.push(`Could not read "${label(field)}" - check it on the page.`)
    } else if (field.category === 'USER_CONFIRMATION_REQUIRED') {
      // Legal attestations, signatures and demographics are never answered for the user.
      blocking.push(`"${label(field)}" needs your own answer (legal or personal).`)
    } else {
      blocking.push(`"${label(field)}" is required and still empty.`)
    }
  }

  for (const error of report.validationErrors) blocking.push(`The page shows an error: ${error.message}`)

  const resumeFields = fields.filter((field) => field.type === 'file' && isResumeUpload(field.label))
  if (resumeFields.length && !resumeFields.some(hasValue)) blocking.push('The resume is not attached.')
  if (session.resume && !session.resume.approved) blocking.push('The tailored resume is not approved.')

  const resumeWarnings = (session.resume?.warnings ?? []).filter((warning) => !warning.message.startsWith('Ignored:'))
  if (resumeWarnings.length) {
    notes.push(
      `Tailored CV - ${resumeWarnings.length} thing${resumeWarnings.length === 1 ? '' : 's'} to check: ${resumeWarnings
        .slice(0, 3)
        .map((warning) => warning.message)
        .join(' ')}`,
    )
  }
  for (const answer of Object.values(session.answers ?? {})) {
    if (answer.warnings.length) notes.push(`Check the answer to "${answer.question}": ${answer.warnings[0]!.message}`)
  }
  if (session.coverLetter?.warnings.length) notes.push(`Cover letter: ${session.coverLetter.warnings[0]!.message}`)

  return { blocking: unique(blocking), notes: unique(notes) }
}

function unique(list: string[]): string[] {
  return [...new Set(list)]
}
