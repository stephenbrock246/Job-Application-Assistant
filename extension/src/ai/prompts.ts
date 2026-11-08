/**
 * Prompt composition and reply parsing - identical for every provider.
 *
 * Replies are treated as untrusted input: a pasted reply may be truncated, wrapped
 * in chat chatter or code fences, or refer to paragraphs that do not exist. Every
 * parser here either returns something structurally valid or throws an
 * `AIReplyError` whose message tells the user what to do.
 */

import { AIReplyError } from './ai-provider.interface'
import type { ApplicationQuestionRequest } from '@/shared/types/ai'
import type { ParagraphEdit, ResumeParagraph } from '@/shared/types/resume'

// ---------------------------------------------------------------------------
// Resume tailoring
// ---------------------------------------------------------------------------

export interface TailorPromptInput {
  paragraphs: readonly ResumeParagraph[]
  tailoringPrompt: string
  /** One-off instructions for this job only. */
  additionalInstructions?: string
  jobDescription: string
  company: string
  position: string
}

export function buildTailorPrompt(input: TailorPromptInput): string {
  const listing = input.paragraphs
    .map((p) => `[P${p.id}${p.role === 'body' ? '' : ` ${p.role}`}] ${escapeControl(p.text)}`)
    .join('\n')

  return [
    input.tailoringPrompt.trim(),
    input.additionalInstructions?.trim()
      ? `Additional instructions for this job only:\n${input.additionalInstructions.trim()}`
      : '',
    `## How to reply

My resume is below as numbered paragraphs like [P12]. Its Word layout must be preserved exactly, so you edit paragraph text - you do not write a new document.

Reply with ONE JSON object and nothing else, in this shape (replace the <...> parts):
{"edits":[{"id":<paragraph number>,"text":"<rewritten paragraph>"}],"removed":[<bullet paragraph number>],"notes":["<what you changed and why>"]}

Rules for the reply:
- "edits" contains only paragraphs you change. Leave the others out.
- You cannot add paragraphs. Improve the ones that exist.
- "removed" may list only bullet paragraphs (marked "bullet") to delete entirely, e.g. a bullet irrelevant to this job. Use it sparingly. Headings, labels, job titles, employers, dates, education and contact details are never removed.
- Keep each paragraph's role: a heading stays a short heading, a bullet stays a single bullet. Keep lengths similar so the page count does not change.
- In the listing, \\t is a tab and \\n a line break inside a paragraph. Keep them where they are (they align dates) and write them as \\t and \\n in the JSON.
- Do not invent employers, job titles, dates, degrees, certifications, metrics or technologies that are not already in my resume.`,
    `## Job\n\nCompany: ${input.company || 'unknown'}\nPosition: ${input.position || 'unknown'}\n\n${input.jobDescription.trim()}`,
    `## My resume\n\n${listing}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface TailorReply {
  edits: ParagraphEdit[]
  notes: string[]
  /** Parts of the reply that were ignored, and why. Shown with the result. */
  ignored: string[]
}

/** Text that only ever appears in our prompts. Seeing it in a "reply" means the prompt was pasted back. */
const PROMPT_MARKERS = ['## How to reply', '## My resume', '## My master resume', '<paragraph number>']

/** Throws if the pasted text is (or contains) the prompt rather than the model's reply. */
export function assertNotPrompt(reply: string): void {
  if (PROMPT_MARKERS.some((marker) => reply.includes(marker))) {
    throw new AIReplyError(
      "This is the prompt, not the reply. Send the prompt in the chat first, then copy the chat's answer (the copy icon under the reply) and paste that here.",
    )
  }
}

export function parseTailorReply(reply: string, paragraphs: readonly ResumeParagraph[]): TailorReply {
  assertNotPrompt(reply)
  const data = extractJson(reply)
  if (!data || typeof data !== 'object') {
    throw new AIReplyError(
      'The reply does not contain the JSON object the prompt asks for. Make sure you copied the whole reply - or ask the chat to "reply with the JSON only" and paste again.',
    )
  }

  const byId = new Map(paragraphs.map((p) => [p.id, p]))
  const edits = new Map<number, ParagraphEdit>()
  const ignored: string[] = []
  const record = data as { edits?: unknown; removed?: unknown; notes?: unknown }

  for (const raw of Array.isArray(record.edits) ? record.edits : []) {
    const id = Number((raw as { id?: unknown }).id)
    const text = (raw as { text?: unknown }).text
    const paragraph = byId.get(id)
    if (!paragraph || typeof text !== 'string') {
      ignored.push(`An edit for paragraph ${String((raw as { id?: unknown }).id)} that does not exist.`)
      continue
    }
    // Some chats double-escape, leaving a literal backslash-t in the string.
    const cleaned = text.replace(/\r\n?/g, '\n').replace(/\\t/g, '\t').replace(/\\n/g, '\n')
    if (!cleaned.trim()) {
      ignored.push(`An empty rewrite of paragraph ${id} (use "removed" to delete it).`)
      continue
    }
    if (cleaned === paragraph.text) continue
    edits.set(id, { id, original: paragraph.text, text: cleaned })
  }

  for (const raw of Array.isArray(record.removed) ? record.removed : []) {
    const id = Number(raw)
    const paragraph = byId.get(id)
    if (!paragraph) {
      ignored.push(`A removal of paragraph ${String(raw)}, which does not exist.`)
      continue
    }
    // Only bullets may go. Headings, labels ("Backend:"), job lines and dates carry
    // the document's structure, and a styled label is not always marked as a heading.
    if (paragraph.role !== 'bullet') {
      ignored.push(`A removal of "${short(paragraph.text)}" - only bullet points can be removed.`)
      continue
    }
    edits.set(id, { id, original: paragraph.text, text: '', removed: true })
  }

  if (!Array.isArray(record.edits) && !Array.isArray(record.removed)) {
    throw new AIReplyError('The JSON in the reply has no "edits" list. Paste the complete reply.')
  }

  const notes = Array.isArray(record.notes)
    ? record.notes.filter((note): note is string => typeof note === 'string' && Boolean(note.trim()))
    : []

  return { edits: [...edits.values()].sort((a, b) => a.id - b.id), notes, ignored }
}

// ---------------------------------------------------------------------------
// Cover letter
// ---------------------------------------------------------------------------

export interface CoverLetterPromptInput {
  resumeText: string
  coverLetterPrompt: string
  additionalInstructions?: string
  jobDescription: string
  company: string
  position: string
  applicantName: string
  /** Current facts from the applicant profile; they override the resume. */
  facts?: string
  /** A sample of the user's own writing, to match its voice. */
  voice?: string
}

const LETTER_START = 'BEGIN LETTER'
const LETTER_END = 'END LETTER'

export function buildCoverLetterPrompt(input: CoverLetterPromptInput): string {
  return [
    input.coverLetterPrompt.trim(),
    input.additionalInstructions?.trim()
      ? `Additional instructions for this job only:\n${input.additionalInstructions.trim()}`
      : '',
    `## How to reply

Write the letter as plain text, with blank lines between paragraphs. Put it between a line reading ${LETTER_START} and a line reading ${LETTER_END}, with nothing else inside.
- Do not use placeholders like [Hiring Manager Name] or [Company Address]. If a name is unknown, use a neutral greeting such as "Dear Hiring Team,".
- Sign off with my name: ${input.applicantName || '(leave the sign-off name out)'}.`,
    FACT_RULES,
    PLAIN_VOICE_RULES,
    input.voice?.trim()
      ? `Here is something I wrote myself. Match its tone, sentence length and word choice (not its content):\n"""\n${input.voice.trim()}\n"""`
      : '',
    input.facts?.trim() ? `## About me (current - overrides the resume)\n\n${input.facts.trim()}` : '',
    `## Job\n\nCompany: ${input.company || 'unknown'}\nPosition: ${input.position || 'unknown'}\n\n${input.jobDescription.trim()}`,
    `## My master resume\n\n${input.resumeText.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function parseCoverLetterReply(reply: string): string {
  assertNotPrompt(reply)
  const text = extractBetween(reply, LETTER_START, LETTER_END) ?? stripChatter(reply)
  if (!text.trim()) throw new AIReplyError('The reply is empty. Paste the letter the chat wrote.')
  // Placeholders are reported by the fact check rather than rejected here, so the
  // user can fix them in the editor instead of re-running the prompt.
  return tidy(text)
}

// ---------------------------------------------------------------------------
// Written application answers
// ---------------------------------------------------------------------------

const ANSWER_START = 'BEGIN ANSWER'
const ANSWER_END = 'END ANSWER'

/**
 * Plain-voice rules shared by answers and cover letters. They target what makes
 * text read as machine-written: generic claims instead of specifics, stock phrases,
 * uniform long sentences, restating the question.
 */
export const PLAIN_VOICE_RULES = `How to write it:
- Sound like a person typing into the form, not a press release: plain words, first person, contractions are fine, and a mix of short and longer sentences.
- Be specific. Name a real project, product, technology or result from my resume instead of a general claim about skills.
- Never use these words or phrases: successfully, leverage, spearheaded, seamless, robust, passionate, dynamic, fast-paced, cutting-edge, synergy, proven track record, I am excited to, delve, tapestry, landscape, in today's world, game-changer. No em dashes, no bullet lists, no exclamation marks.
- Do not restate the question, and do not end with a summary sentence.`

/** Fact rules: the profile is current and wins; what is unknown is left visibly blank. */
const FACT_RULES = `Facts - the most important rule:
- State only facts from "About me" and my resume. "About me" is current and overrides the resume wherever they differ.
- Never state where I live, my work authorization, visa or sponsorship needs, salary, availability, dates or numbers unless they are written below. You may give the time zone of a location that is written below.
- If the question needs a fact that is in neither, write [ADD: what is missing] in its place. Never guess it.`

export function buildAnswerPrompt(input: ApplicationQuestionRequest): string {
  return [
    `Draft my answer to this job application question for the role below, in my own voice.`,
    `Question: ${input.question.trim()}`,
    input.constraints
      ? `Length: ${input.constraints}`
      : 'Length: answer the question in the first sentence, then two to four more sentences at most - unless the question asks for more.',
    FACT_RULES,
    PLAIN_VOICE_RULES,
    input.voice?.trim()
      ? `Here is something I wrote myself. Match its tone, sentence length and word choice (not its content):\n"""\n${input.voice.trim()}\n"""`
      : '',
    `Reply with the answer only, between a line reading ${ANSWER_START} and a line reading ${ANSWER_END}.`,
    input.facts?.trim() ? `## About me (current - overrides the resume)\n\n${input.facts.trim()}` : '',
    `## Job\n\nCompany: ${input.company || 'unknown'}\nPosition: ${input.position || 'unknown'}\n\n${input.jobDescription.trim()}`,
    `## My resume\n\n${input.resumeText.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Several written questions from one page in one request (API key mode). The reply
 * uses the same [1] ... [2] ... format as the answers chat, so it is parsed the same way.
 */
export function buildQuestionsPrompt(input: {
  questions: { text: string; maxLength?: number }[]
  jobDescription: string
  company: string
  position: string
  resumeText: string
  facts?: string
  voice?: string
}): string {
  const numbered = input.questions
    .map((q, index) => `[${index + 1}] ${q.text.replace(/\s*\*\s*$/, '').trim()}${q.maxLength ? ` (max ${q.maxLength} characters)` : ''}`)
    .join('\n')
  return [
    'Draft my answers to these job application questions for the role below, in my own voice.',
    `## Questions\n\n${numbered}`,
    'Length: answer each question in its first sentence, then two to four more sentences at most - unless the question asks for more or gives a limit.',
    FACT_RULES,
    PLAIN_VOICE_RULES,
    input.voice?.trim()
      ? `Here is something I wrote myself. Match its tone, sentence length and word choice (not its content):\n"""\n${input.voice.trim()}\n"""`
      : '',
    'Reply with each answer after its number in brackets, like [1] ... [2] ... - answers only: no headings, and do not repeat the questions.',
    input.facts?.trim() ? `## About me (current - overrides the resume)\n\n${input.facts.trim()}` : '',
    `## Job\n\nCompany: ${input.company || 'unknown'}\nPosition: ${input.position || 'unknown'}\n\n${input.jobDescription.trim()}`,
    `## My resume\n\n${input.resumeText.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function parseAnswerReply(reply: string): string {
  assertNotPrompt(reply)
  const text = extractBetween(reply, ANSWER_START, ANSWER_END) ?? stripChatter(reply)
  if (!text.trim()) throw new AIReplyError('The reply is empty. Paste the answer the chat wrote.')
  return tidy(text)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Finds the JSON object in a reply: inside a ```json fence, or the outermost braces. */
export function extractJson(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1]
  const candidates = [fenced, reply]
  for (const candidate of candidates) {
    if (!candidate) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start === -1 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      /* try the next candidate */
    }
  }
  return null
}

function extractBetween(reply: string, start: string, end: string): string | null {
  const from = reply.indexOf(start)
  if (from === -1) return null
  const to = reply.indexOf(end, from + start.length)
  // A missing end marker usually means the copy was cut short; take what is there.
  return reply.slice(from + start.length, to === -1 ? undefined : to)
}

/** Removes code fences and a leading "Here is your letter:" line. */
function stripChatter(reply: string): string {
  return reply
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s*(sure|certainly|here( is|'s)|below is)[^\n]*:\s*\n/i, '')
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeControl(text: string): string {
  return text.replace(/\t/g, '\\t').replace(/\n/g, '\\n')
}

function short(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}
