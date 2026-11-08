/**
 * Cover letters and drafted application answers (cover letter addendum, spec 9).
 *
 * Both are grounded in the master resume and the job description, use their own
 * prompts, and come back as plain text the user edits before anything reaches a
 * form. Fabrication warnings are attached exactly as for the resume.
 */

import { buildAnswerPrompt, buildCoverLetterPrompt, buildQuestionsPrompt, parseAnswerReply, parseCoverLetterReply } from '@/ai/prompts'
import { checkFacts } from './fact-check'
import { requireJobDescription, requireMaster } from './resume-tailor'
import { getDefaultPrompt } from '@/storage/prompts'
import { profileSlot } from '@/storage/applicant-profile'
import { preferencesSlot } from '@/storage/settings'
import { HUMANIZER_MIN_WORDS, humanize, wordCount } from '@/ai/humanizer'
import { AICancelledError } from '@/ai/retry'
import type { ApplicantProfile } from '@/shared/types/profile'
import { coverLetterFileName } from '@/shared/utils/format'
import { renderLetterPdf } from './pdf'
import { PDF_MIME, type GeneratedFile } from './resume-generator'
import type { ApplicationSession } from '@/shared/types/application'
import type { PendingAITask } from '@/shared/types/ai'
import type { CoverLetterState, DraftedAnswer } from '@/shared/types/resume'

async function applicantName(): Promise<string> {
  const profile = await profileSlot.get()
  const { fullName, firstName, lastName } = profile.personal
  return fullName.trim() || [firstName, lastName].filter(Boolean).join(' ').trim()
}

function allowedTerms(session: ApplicationSession, name: string): string[] {
  return [session.company, session.position, name].filter(Boolean)
}

/**
 * The applicant's current facts from their profile - the answer to "where are you
 * located", "do you need sponsorship", "when can you start". Without these a model
 * guesses, and a guess here is a false statement on an application. Only filled
 * fields are listed; the prompt says what is missing must be left as [ADD: ...].
 */
export function applicantFacts(profile: ApplicantProfile): string {
  const { personal, professional, preferences, workAuthorization } = profile
  const location = [personal.city, personal.state, personal.country].map((part) => part.trim()).filter(Boolean)
  const lines: [string, string][] = [
    ['Name', personal.fullName || [personal.firstName, personal.lastName].filter(Boolean).join(' ')],
    ['Where I live', location.join(', ')],
    ['Work authorization', workAuthorization.workAuthorization],
    ['Visa sponsorship needed', workAuthorization.sponsorshipRequired],
    ['Current title', professional.currentTitle],
    ['Current company', professional.currentCompany],
    ['Years of experience', professional.yearsOfExperience],
    ['Notice period', preferences.noticePeriod],
    ['Available to start', preferences.availableStartDate],
    ['Remote / on-site preference', preferences.remotePreference],
    ['Open to relocation', preferences.relocationPreference],
    ['Expected salary', preferences.expectedSalary ? `${preferences.expectedSalary} ${preferences.salaryCurrency} per ${preferences.salaryPeriod.replace(/ly$/, '')}` : ''],
  ]
  return lines
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `- ${label}: ${value.trim()}`)
    .join('\n')
}

/** Everything the applicant has said about themselves - what generated text may state. */
async function knownFacts(): Promise<{ facts: string; voice: string; source: string }> {
  const [master, profile, prefs] = await Promise.all([requireMaster(), profileSlot.get(), preferencesSlot.get()])
  const facts = applicantFacts(profile)
  return { facts, voice: prefs.writingSample, source: `${master.text}\n${facts}` }
}

// ---------------------------------------------------------------------------
// Cover letter
// ---------------------------------------------------------------------------

export async function composeCoverLetter(
  session: ApplicationSession,
  options: { instructions?: string },
): Promise<PendingAITask> {
  const master = await requireMaster()
  const profile = await getDefaultPrompt('coverLetter')
  const instructions = options.instructions?.trim()
  const { facts, voice } = await knownFacts()

  return {
    kind: 'coverLetter',
    prompt: buildCoverLetterPrompt({
      resumeText: master.text,
      coverLetterPrompt: profile.prompt,
      ...(instructions ? { additionalInstructions: instructions } : {}),
      jobDescription: requireJobDescription(session),
      company: session.company,
      position: session.position,
      applicantName: await applicantName(),
      facts,
      voice,
    }),
    createdAt: Date.now(),
    promptProfileId: profile.id,
    ...(instructions ? { instructions } : {}),
  }
}

export async function finishCoverLetter(
  session: ApplicationSession,
  task: PendingAITask,
  reply: string,
): Promise<CoverLetterState> {
  const text = parseCoverLetterReply(reply)
  return withLetterChecks(session, {
    text,
    ...(task.instructions ? { instructions: task.instructions } : {}),
    warnings: [],
    generatedAt: Date.now(),
    approved: false,
  })
}

/** Recomputes warnings - after generation, and after every user edit. */
export async function withLetterChecks(
  session: ApplicationSession,
  letter: CoverLetterState,
): Promise<CoverLetterState> {
  const { source } = await knownFacts()
  const name = await applicantName()
  return {
    ...letter,
    warnings: checkFacts(letter.text, {
      source,
      jobDescription: session.jobInfo?.description ?? '',
      allowed: allowedTerms(session, name),
      checkNames: true,
    }),
  }
}

/** "{First}_{Last}_Cover_Letter.pdf"; the session's job is the folder it is saved in. */
export async function generateLetterPdf(_session: ApplicationSession, text: string): Promise<GeneratedFile> {
  const profile = await profileSlot.get()
  const { email, phone, city, state, linkedin } = profile.personal
  const fileName = coverLetterFileName(await applicantName())
  return {
    fileName,
    mime: PDF_MIME,
    bytes: await renderLetterPdf(
      text,
      {
        name: await applicantName(),
        contact: [email, phone, [city, state].filter(Boolean).join(', '), linkedin].filter(Boolean).join('  |  '),
      },
      fileName.replace(/\.pdf$/, ''),
    ),
  }
}

// ---------------------------------------------------------------------------
// Written application answers
// ---------------------------------------------------------------------------

export async function composeAnswer(
  session: ApplicationSession,
  field: { id: string; label: string; maxLength?: number },
): Promise<PendingAITask> {
  const master = await requireMaster()
  const { facts, voice } = await knownFacts()
  return {
    kind: 'answer',
    fieldId: field.id,
    question: field.label,
    prompt: buildAnswerPrompt({
      question: field.label,
      ...(field.maxLength ? { constraints: `At most ${field.maxLength} characters.` } : {}),
      jobDescription: requireJobDescription(session),
      company: session.company,
      position: session.position,
      resumeText: master.text,
      facts,
      voice,
    }),
    createdAt: Date.now(),
  }
}

/** Sentence-start words that are capitalised but carry no fact - not worth freezing. */
const FUNCTION_WORDS = new Set(
  'I My In At The A An As On For With When While Since This That These We Our It Its If So But And Also Then After Before Most Over'.split(' '),
)

/**
 * The words a rewrite must not touch: names, places, technologies, numbers, the
 * company and position, and any [ADD: ...] gap. These carry the facts; rewording
 * around them is fine, changing them is not.
 */
function freezeTerms(text: string, session: ApplicationSession): string[] {
  const terms = new Set<string>()
  for (const match of text.matchAll(/\[[^\]\n]{2,60}\]/g)) terms.add(match[0])
  for (const match of text.matchAll(/\b[A-Z][A-Za-z0-9+#.]*[A-Za-z0-9+#]|\b[A-Z]\b/g)) {
    if (!FUNCTION_WORDS.has(match[0])) terms.add(match[0])
  }
  for (const match of text.matchAll(/\$?\d[\d,.]*\s?(?:%|k\b|\+|years?\b)?/gi)) terms.add(match[0].trim())
  for (const name of [session.company, session.position]) if (name.trim()) terms.add(name.trim())
  return [...terms].filter((term) => term.length > 0)
}

/**
 * Optional HumanGPT rewrite of a drafted answer (Settings > AI > Humanizer). Never
 * fails the draft: if the humanizer is off, the answer too short, or HumanGPT
 * errors, the AI's draft is returned with a note saying why. A rewrite is
 * fact-checked again from scratch - it may have shifted what the answer claims.
 */
export async function humanizeAnswer(
  session: ApplicationSession,
  answer: DraftedAnswer,
  options: { signal?: AbortSignal; report?: (message: string) => void } = {},
): Promise<DraftedAnswer> {
  const prefs = await preferencesSlot.get()
  if (!prefs.humanizerEnabled) return answer
  if (wordCount(answer.text) < HUMANIZER_MIN_WORDS) {
    return { ...answer, humanizerNote: `Not humanized: HumanGPT needs at least ${HUMANIZER_MIN_WORDS} words.` }
  }
  // Leave gaps for the user to fill first; rewriting around [ADD: ...] helps nobody.
  if (/\[ADD:/i.test(answer.text)) {
    return { ...answer, humanizerNote: 'Not humanized: fill in the missing fact first, then press Draft again.' }
  }

  options.report?.('Rewriting with HumanGPT...')
  try {
    const result = await humanize(answer.text, {
      mode: prefs.humanizerMode,
      freeze: freezeTerms(answer.text, session),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const { source } = await knownFacts()
    return {
      ...answer,
      text: result.text,
      originalText: answer.text,
      humanized: {
        mode: prefs.humanizerMode,
        aiScore: result.aiScore,
        resisted: result.resisted,
        wordsRemaining: result.wordsRemaining,
      },
      warnings: checkFacts(result.text, {
        source,
        jobDescription: session.jobInfo?.description ?? '',
        allowed: [...allowedTerms(session, await applicantName()), answer.question],
        checkNames: true,
      }),
    }
  } catch (error) {
    if (error instanceof AICancelledError) throw error
    return { ...answer, humanizerNote: `Not humanized: ${error instanceof Error ? error.message : 'HumanGPT failed.'}` }
  }
}

/** One request for a page's written questions (API key mode), grounded in the resume, profile and job. */
export async function composeQuestionsPrompt(
  session: ApplicationSession,
  fields: { label: string; maxLength?: number }[],
): Promise<string> {
  const master = await requireMaster()
  const { facts, voice } = await knownFacts()
  return buildQuestionsPrompt({
    questions: fields.map((field) => ({ text: field.label, ...(field.maxLength ? { maxLength: field.maxLength } : {}) })),
    jobDescription: requireJobDescription(session),
    company: session.company,
    position: session.position,
    resumeText: master.text,
    facts,
    voice,
  })
}

/** The fact check for one drafted answer: anything stated that the resume and profile do not support. */
export async function answerWarnings(session: ApplicationSession, question: string, text: string) {
  const { source } = await knownFacts()
  return checkFacts(text, {
    source,
    jobDescription: session.jobInfo?.description ?? '',
    allowed: [...allowedTerms(session, await applicantName()), question],
    checkNames: true,
  })
}

export async function finishAnswer(
  session: ApplicationSession,
  task: PendingAITask,
  reply: string,
): Promise<DraftedAnswer> {
  const { source } = await knownFacts()
  const text = parseAnswerReply(reply)
  return {
    fieldId: task.fieldId ?? '',
    question: task.question ?? '',
    text,
    warnings: checkFacts(text, {
      source,
      jobDescription: session.jobInfo?.description ?? '',
      // The question itself may name places or terms ("the United States").
      allowed: [...allowedTerms(session, await applicantName()), task.question ?? ''],
      checkNames: true,
    }),
    generatedAt: Date.now(),
  }
}
