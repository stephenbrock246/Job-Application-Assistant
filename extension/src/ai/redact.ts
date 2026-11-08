/**
 * Keeps contact details out of prompts sent to a provider that may learn from them.
 *
 * Emails, phone numbers and links are swapped for placeholders like [EMAIL-1]
 * before sending, and swapped back in the reply - so the model never sees them,
 * yet anything it echoes (a contact line, a letter's sign-off) comes back intact.
 * Tailoring and cover letters do not need them to do their job.
 */

const PATTERNS: { kind: string; pattern: RegExp }[] = [
  { kind: 'EMAIL', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // Links with a scheme or a www./known-profile host.
  {
    kind: 'LINK',
    pattern: /\b(?:https?:\/\/|www\.)[^\s|,;)]+|\b(?:linkedin\.com|github\.com|gitlab\.com)\/[^\s|,;)]+/gi,
  },
  // 9+ digits, optionally with +, spaces, dots, dashes or brackets between them - on
  // one line: digits on the next line (a date) are not part of the number.
  { kind: 'PHONE', pattern: /\+?\(?\d[\d \t().-]{7,}\d/g },
]

export interface Redaction {
  text: string
  /** Puts the original values back wherever a placeholder appears. */
  restore: (reply: string) => string
  count: number
}

export function redactContacts(input: string): Redaction {
  const values = new Map<string, string>()
  const placeholders = new Map<string, string>()
  const counters: Record<string, number> = {}
  let text = input

  for (const { kind, pattern } of PATTERNS) {
    text = text.replace(pattern, (match) => {
      // A phone match must really be a phone: enough digits, and not a year range.
      if (
        kind === 'PHONE' &&
        (match.replace(/\D/g, '').length < 9 || /\b(19|20)\d{2}\s*[-–]\s*(19|20)\d{2}\b/.test(match))
      ) {
        return match
      }
      const existing = placeholders.get(match)
      if (existing) return existing
      counters[kind] = (counters[kind] ?? 0) + 1
      const placeholder = `[${kind}-${counters[kind]}]`
      placeholders.set(match, placeholder)
      values.set(placeholder, match)
      return placeholder
    })
  }

  return {
    text,
    count: values.size,
    restore: (reply) => reply.replace(/\[(EMAIL|LINK|PHONE)-\d+\]/g, (placeholder) => values.get(placeholder) ?? placeholder),
  }
}
