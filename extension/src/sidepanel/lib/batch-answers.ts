/**
 * Written questions, answered in one go - in the user's answers chat, or by the
 * API key's model.
 *
 *   the page's open written questions (the ones the extension cannot answer from
 *   saved data - never dropdowns, choices, checkboxes, legal or demographic
 *   questions) -> one numbered message to the answers chat (questions only, no CV
 *   or job description - the chat knows the user) -> numbered reply -> each
 *   answer typed into its field.
 *
 * Works page by page: after Next, the new page's questions are sent the same way.
 */

import { apiProviderId, getProvider, usesApiKey } from '@/ai'
import { answerWarnings, composeQuestionsPrompt } from '@/resume/cover-letter'
import { throwIfCancelled } from '@/ai/retry'
import { sendMessage } from '@/shared/utils/messaging'
import type { ApplicationField, ApplicationSession } from '@/shared/types/application'
import type { DraftedAnswer } from '@/shared/types/resume'
import type { Preferences } from '@/shared/types/settings'
import type { WritingPatch } from '@/shared/types/messages'

/** Open written questions on the current page: the ones "Draft with AI" is for. */
export function writtenQuestions(session: ApplicationSession): ApplicationField[] {
  const report = session.lastReport
  if (!report) return []
  const seen = new Set<string>()
  return [...report.ask, ...report.skipped]
    .map((plan) => plan.field)
    .filter((field) => {
      if (seen.has(field.id)) return false
      seen.add(field.id)
      return (
        field.category === 'AI_GENERATED' &&
        field.canonicalField !== 'coverLetter' &&
        (field.type === 'text' || field.type === 'textarea') &&
        !field.widget &&
        !field.value
      )
    })
}

/** The message: the user's line, then the questions as [1] ... [n]. */
export function questionsMessage(session: ApplicationSession, prefs: Preferences, fields: ApplicationField[]): string {
  const intro = prefs.chatgptAnswersMessage
    .replace(/\{company\}/g, session.company.trim() || 'this company')
    .replace(/\{position\}/g, session.position.trim() || 'this')
    .trim()
  const questions = fields.map((field, index) => {
    const limit = field.maxLength ? ` (max ${field.maxLength} characters)` : ''
    return `[${index + 1}] ${field.label.replace(/\s*\*\s*$/, '').trim()}${limit}`
  })
  return [intro, questions.join('\n')].filter(Boolean).join('\n\n')
}

/**
 * Answers by number from the reply: "[1] ...", "**[1]** ...", "1. ..." or "1) ...".
 * A line repeating the question before its answer is dropped.
 */
export function parseNumberedAnswers(reply: string, questions: string[]): Map<number, string> {
  const answers = new Map<number, string>()
  const text = reply.replace(/\r\n?/g, '\n')
  const marker = /^[ \t>*_#-]*(?:\\?\[(\d{1,2})\\?\]|(\d{1,2})[.)])[*_:\s]*/gm
  const hits = [...text.matchAll(marker)].filter((m) => {
    const n = Number(m[1] ?? m[2])
    return n >= 1 && n <= questions.length
  })
  // Bracketed numbers win when the reply uses them (a numbered list inside an answer stays in it).
  const bracketed = hits.filter((m) => m[1])
  const used = bracketed.length ? bracketed : hits
  for (let i = 0; i < used.length; i++) {
    const hit = used[i]!
    const n = Number(hit[1] ?? hit[2])
    if (answers.has(n)) continue
    const start = hit.index! + hit[0].length
    const end = i + 1 < used.length ? used[i + 1]!.index! : text.length
    let answer = text.slice(start, end).trim()
    const question = questions[n - 1]!.toLowerCase().replace(/\s+/g, ' ').trim()
    const firstLine = answer.split('\n')[0]!.replace(/[*_]/g, '').toLowerCase().trim()
    if (firstLine && (firstLine === question || question.startsWith(firstLine.replace(/[?:]$/, '')))) {
      answer = answer.split('\n').slice(1).join('\n').trim()
    }
    answer = answer
      .replace(/^(?:\*\*)?(?:answer|a)\s*:\s*(?:\*\*)?/i, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (answer) answers.set(n, answer)
  }
  return answers
}

/**
 * Sends the questions, then types each answer into its field. Returns how many
 * were filled, which questions got no answer, and which answers need a fact only
 * the user has (an [ADD: ...] gap) - those are kept but never typed into the form.
 *
 * Answers chat: questions only (the chat knows the user). API key: one request
 * with the resume, profile facts and job, and each answer is fact-checked.
 */
export async function answerInChat(
  session: ApplicationSession,
  prefs: Preferences,
  fields: ApplicationField[],
  update: (patch: WritingPatch) => Promise<void>,
  options: { signal?: AbortSignal; report?: (message: string) => void } = {},
): Promise<{ filled: number; unanswered: string[]; failed: string[]; needsFact: string[] }> {
  if (!fields.length) throw new Error('There are no written questions on this page.')
  const api = usesApiKey(prefs)
  const provider = getProvider(api ? apiProviderId(prefs) : 'chatgpt-answers')
  const count = `${fields.length} question${fields.length === 1 ? '' : 's'}`
  options.report?.(api ? `Waiting for ${provider.label} (${count})...` : `Waiting for the answers chat (${count})...`)
  const message = api ? await composeQuestionsPrompt(session, fields) : questionsMessage(session, prefs, fields)
  const reply = await provider.complete!(message, options.signal ? { signal: options.signal } : {})
  throwIfCancelled(options.signal)

  const answers = parseNumberedAnswers(reply, fields.map((field) => field.label))
  if (!answers.size) {
    throw new Error(
      api
        ? `${provider.label} replied without numbered answers. Send again.`
        : 'The chat replied without numbered answers. Ask it to reply in the [1] ... [2] ... format, then send again.',
    )
  }

  // Keep every answer on the application, then type them in one by one.
  const now = Date.now()
  const drafted: Record<string, DraftedAnswer> = {}
  for (const [index, field] of fields.entries()) {
    const text = answers.get(index + 1)
    if (!text) continue
    const warnings = api ? await answerWarnings(session, field.label, text) : []
    drafted[field.id] = { fieldId: field.id, question: field.label, text, warnings, generatedAt: now }
  }
  await update({ answers: drafted })

  let filled = 0
  const failed: string[] = []
  const needsFact: string[] = []
  for (const [index, field] of fields.entries()) {
    const text = answers.get(index + 1)
    if (!text) continue
    // "[ADD: your salary]" typed into a real application is worse than an empty box.
    if (/\[ADD:/i.test(text)) {
      needsFact.push(field.label)
      continue
    }
    throwIfCancelled(options.signal)
    options.report?.(`Filling answer ${index + 1} of ${fields.length}...`)
    try {
      await sendMessage('page/answerField', { sessionId: session.id, fieldId: field.id, value: text, saveAsDefault: false, label: field.label })
      filled++
    } catch {
      failed.push(field.label)
    }
  }
  const unanswered = fields.filter((_, index) => !answers.has(index + 1)).map((field) => field.label)
  return { filled, unanswered, failed, needsFact }
}
