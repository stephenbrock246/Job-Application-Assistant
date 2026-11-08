/**
 * "Never fabricate" check (spec section 27).
 *
 * A model asked to tailor toward a job description is most tempted to do two
 * things: adopt the job's technologies as if they were the candidate's, and invent
 * or inflate numbers. Both are mechanically detectable against the master resume:
 *
 *   - a number (metric, year, count) in generated text that the master never states;
 *   - a term that appears in the job description and in generated text, but nowhere
 *     in the master resume;
 *   - a leftover [Placeholder].
 *
 * Warnings never block anything. They are shown next to the text so the user
 * decides, which is the point: the user is the one who knows what is true.
 */

import type { FactWarning } from '@/shared/types/resume'

const NUMBER = /\$?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|\+|x\b)?/gi

/** Capitalised words that are never technologies or claims. */
const COMMON = new Set(
  (
    'a an and are as at be but by can do for from has have i if in is it its may more most ' +
    'not of on or our so than that the their them then there these they this to us we what ' +
    'when where which who will with would you your about after all also any before both each ' +
    'experience engineer engineering senior junior lead team teams work working role job ' +
    'strong excellent ability skills responsibilities requirements required preferred ' +
    'qualifications bonus plus years year including within across new build building ' +
    'january february march april may june july august september october november december ' +
    'monday tuesday wednesday thursday friday remote hybrid onsite dear hiring manager sincerely regards ' +
    // Time-zone vocabulary: the prompt allows naming the zone of a location the user gave.
    'time standard daylight summer eastern western central pacific mountain atlantic european greenwich utc gmt'
  ).split(/\s+/),
)

export interface FactCheckContext {
  /** Everything the candidate has said about themselves: the master resume text. */
  source: string
  jobDescription: string
  /** Terms allowed even if absent from the source (company name, position). */
  allowed?: string[]
  /**
   * Also flag capitalised names (places, companies, schools) that appear in none of
   * the sources. For free-written text - answers and letters - where a model is
   * most tempted to fill a gap, e.g. inventing where the applicant lives.
   */
  checkNames?: boolean
}

export function checkFacts(generated: string, context: FactCheckContext, paragraphId?: number): FactWarning[] {
  const warnings: string[] = []
  const source = context.source.toLowerCase()
  const allowed = (context.allowed ?? []).join(' ').toLowerCase()

  // 1. Numbers the master never states.
  const sourceNumbers = new Set(numbersIn(context.source))
  for (const number of new Set(numbersIn(generated))) {
    if (!sourceNumbers.has(number) && !allowed.includes(number)) {
      warnings.push(`"${number}" is not in your master resume - check it is true.`)
    }
  }

  // 2. Job-description terms the master does not contain.
  for (const term of jobTerms(context.jobDescription)) {
    if (!containsTerm(generated, term)) continue
    if (containsTerm(source, term.toLowerCase()) || containsTerm(allowed, term.toLowerCase())) continue
    warnings.push(`"${term}" comes from the job description and is not in your master resume.`)
  }

  // 3. Names nobody gave the model.
  if (context.checkNames) {
    const known = `${source}\n${context.jobDescription.toLowerCase()}\n${allowed}`
    for (const name of namesIn(generated)) {
      if (COMMON.has(name.toLowerCase()) || containsTerm(known, name.toLowerCase())) continue
      warnings.push(`"${name}" is not in your resume, profile or the job description - check it is true.`)
    }
  }

  // 4. Leftover placeholders - including the [ADD: ...] gaps the model was told to leave.
  for (const match of generated.matchAll(/\[[^\]\n]{2,60}\]/g)) {
    const missing = /^\[ADD:\s*(.+)\]$/i.exec(match[0])?.[1]
    warnings.push(missing ? `Missing fact: ${missing} - fill it in before using this.` : `Placeholder ${match[0]} needs replacing.`)
  }

  return [...new Set(warnings)].map((message) =>
    paragraphId === undefined ? { message } : { paragraphId, message },
  )
}

/**
 * Capitalised words that are not the first word of a sentence ("based in China",
 * "Pacific Time", "CST") - the shape of a proper name. Sentence starts are skipped
 * because every sentence starts with a capital.
 */
function namesIn(text: string): string[] {
  const names = new Set<string>()
  for (const match of text.matchAll(/\b([A-Z][A-Za-z]+)\b/g)) {
    const word = match[1]!
    const index = match.index ?? 0
    const before = text.slice(Math.max(0, index - 3), index)
    if (index === 0 || /[.!?:\n]\s*$/.test(before) || word === 'I') continue
    names.add(word)
  }
  return [...names]
}

function numbersIn(text: string): string[] {
  return Array.from(text.matchAll(NUMBER), (match) =>
    match[0].toLowerCase().replace(/[$,\s]/g, '').replace(/\.$/, ''),
  ).filter((value) => /\d/.test(value) && value !== '1')
}

/**
 * Technology/claim-like terms in a job description: capitalised words and
 * anything with digits or symbols (C++, Node.js, S3, CI/CD).
 */
function jobTerms(jd: string): string[] {
  const terms = new Set<string>()
  for (const match of jd.matchAll(/[A-Za-z][A-Za-z0-9+#./-]*[A-Za-z0-9+#]|[A-Z]/g)) {
    const term = match[0].replace(/[./-]+$/, '')
    if (term.length < 2 && term !== 'C' && term !== 'R') continue
    const special = /[A-Z].*[A-Z]|\d|[+#.]/.test(term.slice(1)) || /[+#]/.test(term)
    const capitalised = /^[A-Z]/.test(term)
    if (!special && !capitalised) continue
    if (COMMON.has(term.toLowerCase())) continue
    terms.add(term)
  }
  return [...terms]
}

function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9+#])`, 'i').test(haystack)
}
