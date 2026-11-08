/** Saved default answers (spec section 7). */

import { defineSlot } from './base'
import { STORAGE_KEYS } from '@/shared/constants/defaults'
import { CANONICAL_FIELDS, CANONICAL_FIELD_BY_KEY } from '@/shared/constants/canonical-fields'
import { normaliseQuestion } from '@/shared/utils/format'
import type { QuestionCategory, SavedAnswer } from '@/shared/types/application'

export const answersSlot = defineSlot<SavedAnswer[]>(STORAGE_KEYS.answers, () => [])

export async function upsertAnswer(answer: Omit<SavedAnswer, 'updatedAt'>): Promise<void> {
  await answersSlot.update((current) => {
    const next = current.filter((a) => a.key !== answer.key)
    next.push({ ...answer, updatedAt: Date.now() })
    return next.sort((a, b) => a.label.localeCompare(b.label))
  })
}

export async function deleteAnswer(key: string): Promise<void> {
  await answersSlot.update((current) => current.filter((a) => a.key !== key))
}

export async function getAnswer(key: string): Promise<SavedAnswer | undefined> {
  const all = await answersSlot.get()
  return all.find((a) => a.key === key)
}

/**
 * Maps a raw question label onto a canonical field key.
 *
 * Deliberately conservative: exact alias match scores highest, then whole-alias
 * containment. A weak partial match returns a low confidence so the caller asks
 * the user instead of filling. Phase 3 layers DOM signals on top of this.
 */
export function matchCanonicalField(
  label: string,
): { key: string; category: QuestionCategory; confidence: number } | null {
  const question = normaliseQuestion(label)
  if (!question) return null

  let best: { key: string; category: QuestionCategory; confidence: number } | null = null

  for (const field of CANONICAL_FIELDS) {
    for (const alias of field.aliases) {
      let confidence = 0
      if (question === alias) confidence = 1
      else if (EXACT_ONLY.has(alias)) continue
      else {
        // Whole words only: "state" is not in "statement", "name" not in "rename".
        const at = wordIndex(question, alias)
        if (at < 0) continue
        confidence = at === 0 || at + alias.length === question.length ? 0.85 : 0.7
      }

      if (confidence < 1) {
        // Very short aliases inside long questions are usually coincidence.
        if (alias.length <= 5) confidence -= 0.25
        // So is a single word in the middle of a sentence ("...experience with mobile development?").
        else if (!alias.includes(' ') && confidence < 0.85) confidence -= 0.2
      }

      if (!best || confidence > best.confidence) {
        best = { key: field.key, category: field.category, confidence }
      }
    }
  }

  return best && best.confidence > 0 ? best : null
}

/**
 * Generic words that name a field only when they are the whole label. Inside a
 * longer label they describe something else: "Company Name", "Referrer Name",
 * "Which region...", "mobile development", "State your reason".
 */
const EXACT_ONLY = new Set(['name', 'mobile', 'region', 'state', 'town'])

/** Index of `words` in `text` as whole words (no letter or digit on either side), or -1. */
function wordIndex(text: string, words: string): number {
  let from = 0
  for (;;) {
    const at = text.indexOf(words, from)
    if (at < 0) return -1
    const before = text[at - 1] ?? ' '
    const after = text[at + words.length] ?? ' '
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return at
    from = at + 1
  }
}

export function categoryOf(key: string): QuestionCategory | undefined {
  return CANONICAL_FIELD_BY_KEY.get(key)?.category
}
