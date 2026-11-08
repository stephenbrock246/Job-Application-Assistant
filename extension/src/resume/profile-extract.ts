/**
 * Applicant profile defaults read from the master resume.
 *
 * Deterministic and local: no AI, nothing sent anywhere. Every suggestion carries
 * the resume text it came from, so the user can see why it is proposed - and
 * nothing is proposed that the resume does not literally state (the profile rule is
 * "never guessed"). Anything not found is simply not suggested.
 */

import type { ResumeParagraph } from '@/shared/types/resume'
import type { ApplicantProfile } from '@/shared/types/profile'

type Section = keyof Omit<ApplicantProfile, 'updatedAt'>

export interface ProfileSuggestion {
  section: Section
  name: string
  label: string
  value: string
  /** The resume text the value was read from. */
  source: string
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PHONE = /\+?\(?\d[\d\s().-]{7,}\d/
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+/i
const GITHUB = /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+/i
const URL = /(?:https?:\/\/|www\.)[^\s|,;)]+/i
/** Words that make a "Word, Word" segment a skill list or a job title, not "City, Country". */
const NOT_A_PLACE =
  /\b(engineer|developer|software|stack|senior|lead|manager|architect|designer|analyst|python|java|javascript|typescript|react|node|cloud|aws|azure|ai|ml|data|healthcare|fintech|devops|frontend|backend|web|mobile|\.net|sql)\b/i
const YEAR_RANGE =
  /((?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2})\s*[-–—]+\s*((?:[A-Za-z]{3,9}\.?\s+)?(?:19|20)\d{2}|present|current|now|today)/i

type SectionKind = 'summary' | 'skills' | 'experience' | 'education' | 'other'

function sectionKind(text: string): SectionKind {
  const t = text.toLowerCase()
  if (/experience|employment|work history|career/.test(t)) return 'experience'
  if (/education|certification|academic|qualification/.test(t)) return 'education'
  if (/skill|technolog|tech stack|competenc|expertise/.test(t)) return 'skills'
  if (/summary|profile|about|objective/.test(t)) return 'summary'
  return 'other'
}

/** A section heading: a heading-styled paragraph, or a short bold line with no colon label. */
function isHeading(p: ResumeParagraph): boolean {
  if (p.role === 'heading') return true
  return p.role === 'body' && p.bold && p.text.trim().length <= 40 && !p.text.trim().endsWith(':')
}

export function extractProfile(paragraphs: readonly ResumeParagraph[]): ProfileSuggestion[] {
  const out: ProfileSuggestion[] = []
  const add = (section: Section, name: string, label: string, value: string, source: string) => {
    const clean = value.replace(/\s+/g, ' ').trim()
    if (clean && !out.some((s) => s.section === section && s.name === name)) {
      out.push({ section, name, label, value: clean, source: source.replace(/\t/g, '  ').trim() })
    }
  }

  // Group paragraphs under the section heading they follow.
  const sections = new Map<SectionKind, ResumeParagraph[]>()
  const header: ResumeParagraph[] = []
  let current: SectionKind | null = null
  for (const p of paragraphs) {
    if (isHeading(p) && p.role !== 'title') {
      current = sectionKind(p.text)
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === null) header.push(p)
    else sections.get(current)!.push(p)
  }
  const headerText = header.map((p) => p.text).join(' | ')

  // --- Name: the first line of the title paragraph, or of the first paragraph when it
  // is just 2-4 words. A name and headline often share one paragraph, split by a line
  // break ("AGAMYRAT AKMYRADOV\nSenior Software Engineer | Python").
  const NAME = /^[\p{L}'.-]+(?:\s+[\p{L}'.-]+){1,3}$/u
  const firstLine = (p: ResumeParagraph) => p.text.split('\n')[0]!.trim()
  const titled = header.find((p) => p.role === 'title')
  const nameParagraph =
    (titled && NAME.test(firstLine(titled)) ? titled : undefined) ??
    header.find((p, i) => i === 0 && NAME.test(firstLine(p))) ??
    titled
  // A second line in the name paragraph is the headline.
  const nameHeadline = nameParagraph?.text.split('\n')[1]?.trim()
  if (nameParagraph) {
    const full = titleCase(firstLine(nameParagraph))
    const words = full.split(/\s+/)
    add('personal', 'fullName', 'Full name', full, nameParagraph.text)
    if (words.length >= 2) {
      add('personal', 'firstName', 'First name', words[0]!, nameParagraph.text)
      add('personal', 'lastName', 'Last name', words[words.length - 1]!, nameParagraph.text)
      if (words.length === 3) add('personal', 'middleName', 'Middle name', words[1]!, nameParagraph.text)
    }
  }

  // --- Contact details: the header first, then anywhere (some resumes put them in a footer line).
  const allText = paragraphs.map((p) => p.text).join('\n')
  const contactSource = (pattern: RegExp) =>
    header.find((p) => pattern.test(p.text))?.text ?? paragraphs.find((p) => pattern.test(p.text))?.text ?? ''

  const email = EMAIL.exec(headerText)?.[0] ?? EMAIL.exec(allText)?.[0]
  if (email) add('personal', 'email', 'Email', email, contactSource(EMAIL))

  const phone = PHONE.exec(headerText)?.[0]
  if (phone && phone.replace(/\D/g, '').length >= 9) add('personal', 'phone', 'Phone', phone, contactSource(PHONE))

  const linkedin = LINKEDIN.exec(allText)?.[0]
  if (linkedin) {
    const path = linkedin.replace(/^.*?linkedin\.com/i, '')
    add('personal', 'linkedin', 'LinkedIn', `https://www.linkedin.com${path}`, contactSource(LINKEDIN))
  }

  const github = GITHUB.exec(allText)?.[0]
  if (github) add('personal', 'github', 'GitHub', normaliseUrl(github), contactSource(GITHUB))

  const site = headerText
    .split(/\s*[|•·]\s*/)
    .map((part) => URL.exec(part)?.[0])
    .find((url) => url && !LINKEDIN.test(url) && !GITHUB.test(url))
  if (site) add('personal', 'portfolio', 'Portfolio / Website', normaliseUrl(site), contactSource(URL))

  // --- Location: a "City, Region" segment of the contact line. Never the name or the
  // headline ("Senior Software Engineer | Python, Healthcare AI" is not a place): the
  // lines holding the email or phone are read first, and segments with job or tech
  // words are skipped.
  const contactLines = header
    .filter((p) => p !== nameParagraph && p.role !== 'subtitle')
    .sort((a, b) => Number(EMAIL.test(b.text) || PHONE.test(b.text)) - Number(EMAIL.test(a.text) || PHONE.test(a.text)))
  location: for (const p of contactLines) {
    for (const part of p.text.split(/\s*[|•·\n]\s*/)) {
      const segment = part.trim()
      if (EMAIL.test(segment) || URL.test(segment) || LINKEDIN.test(segment) || /\d{5,}/.test(segment)) continue
      if (NOT_A_PLACE.test(segment)) continue
      const match = /^([\p{L}][\p{L} .'-]{1,40}),\s*([\p{L}][\p{L} .'-]{1,40})$/u.exec(segment)
      if (!match) continue
      add('personal', 'city', 'City', match[1]!, p.text)
      const region = match[2]!.trim()
      if (/^[A-Z]{2}$/.test(region) && US_STATES.has(region)) add('personal', 'state', 'State / Province', region, p.text)
      else add('personal', 'country', 'Country', region, p.text)
      break location
    }
  }

  // --- Headline (subtitle), used when no current job line exists.
  const headline = header.find((p) => p.role === 'subtitle')

  // --- Experience: job lines are the non-bullet lines carrying a date range.
  const experience = sections.get('experience') ?? []
  const jobs = experience
    .filter((p) => p.role !== 'bullet' && YEAR_RANGE.test(p.text))
    .map((p) => {
      const range = YEAR_RANGE.exec(p.text)!
      const head = p.text.slice(0, range.index).replace(/[\t\s|,–—-]+$/, '')
      const parts = head.split(/\s*[|•·]\s*|\s+at\s+|\s*,\s*/).filter(Boolean)
      return {
        text: p.text,
        title: parts[0] ?? '',
        company: parts[1] ?? '',
        start: Number(/(?:19|20)\d{2}/.exec(range[1]!)?.[0]),
        current: /present|current|now|today/i.test(range[2]!),
      }
    })

  const currentJob = jobs.find((job) => job.current) ?? null
  if (currentJob?.title) add('professional', 'currentTitle', 'Current job title', currentJob.title, currentJob.text)
  else if (headline) add('professional', 'currentTitle', 'Current job title', titleCase(headline.text), headline.text)
  else if (nameHeadline && !EMAIL.test(nameHeadline)) {
    // "Senior Software Engineer | Python, Healthcare AI" -> the title before the first separator.
    const title = nameHeadline.split(/\s*[|•·–—]\s*/)[0]!.trim()
    if (title) add('professional', 'currentTitle', 'Current job title', title, nameHeadline)
  }
  if (currentJob?.company) add('professional', 'currentCompany', 'Current company', currentJob.company, currentJob.text)

  // --- Years of experience: what the resume states, else counted from the earliest job.
  const stated = /(\d{1,2})\s*\+?\s*(?:\+\s*)?years?/i.exec((sections.get('summary') ?? header).map((p) => p.text).join(' '))
  if (stated) {
    const statedSource = (sections.get('summary') ?? header).find((p) => p.text.includes(stated[0]))?.text ?? ''
    add('professional', 'yearsOfExperience', 'Years of experience', `${stated[1]}+`, statedSource)
  } else if (jobs.length) {
    const earliest = Math.min(...jobs.map((job) => job.start).filter(Number.isFinite))
    if (Number.isFinite(earliest)) {
      const years = new Date().getFullYear() - earliest
      add('professional', 'yearsOfExperience', 'Years of experience', String(years), `Earliest role starts ${earliest}`)
    }
  }

  // --- Skills: the listed items of the skills section.
  const skills = uniqueSkills((sections.get('skills') ?? []).filter((p) => p.role === 'bullet' || !p.bold))
  if (skills.length) {
    add('professional', 'primarySkills', 'Primary skills', skills.slice(0, 20).join(', '), 'Skills section')
  }

  // --- Education: the non-bullet lines of the education section.
  const education = (sections.get('education') ?? [])
    .filter((p) => p.role !== 'bullet')
    .map((p) => p.text.replace(/\t+/g, ' ').replace(/\s*\|\s*/g, ', ').replace(/[,\s]+$/, '').trim())
    .filter(Boolean)
  if (education.length) add('professional', 'education', 'Education', education.join('; '), education.join('; '))

  return out
}

/**
 * "Modern frameworks: React, Angular" -> React, Angular. Commas inside brackets do
 * not split. A line counts as a list of skills only when most of its items look
 * like names; prose such as "Database design, indexing, query optimization" is skipped.
 */
function uniqueSkills(paragraphs: ResumeParagraph[]): string[] {
  const seen = new Set<string>()
  const skills: string[] = []
  for (const p of paragraphs) {
    const body = p.text.includes(':') ? p.text.slice(p.text.indexOf(':') + 1) : p.text
    const items = splitTopLevel(body)
      .map((raw) => raw.replace(/\s+/g, ' ').replace(/^[&\s]+|[.\s]+$/g, '').trim())
      .filter(Boolean)
    const names = items.filter(isNameLike)
    if (!items.length || names.length * 2 < items.length) continue

    for (const item of names) {
      const key = item.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      skills.push(item)
    }
  }
  return skills
}

/** "Vue.js", "SQL Server", "Node.js (Express, NestJS)", "CSS3" - every word capitalised or technical. */
function isNameLike(item: string): boolean {
  if (item.length > 30) return false
  const words = item.replace(/[()[\]]/g, ' ').split(/\s+/).filter(Boolean)
  if (!words.length || words.length > 4) return false
  return words.every((word) => word === '&' || /[A-Z0-9]/.test(word))
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if ((char === ',' || char === ';') && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

/** "daniel garcia" / "DANIEL GARCIA" -> "Daniel Garcia"; mixed case is left as written. */
function titleCase(text: string): string {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text
  return text.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toUpperCase())
}

function normaliseUrl(url: string): string {
  const trimmed = url.replace(/[.,;]+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(
    ' ',
  ),
)

/**
 * Which suggestions to apply. With `onlyEmpty`, a field that already holds a value
 * is never touched - the safe default for automatic filling.
 */
export function mergeSuggestions(
  profile: ApplicantProfile,
  suggestions: readonly ProfileSuggestion[],
  onlyEmpty: boolean,
): { profile: ApplicantProfile; applied: ProfileSuggestion[] } {
  const next: ApplicantProfile = {
    ...profile,
    personal: { ...profile.personal },
    professional: { ...profile.professional },
    preferences: { ...profile.preferences },
    workAuthorization: { ...profile.workAuthorization },
  }
  const applied: ProfileSuggestion[] = []
  for (const suggestion of suggestions) {
    const group = next[suggestion.section] as unknown as Record<string, string>
    const existing = (group[suggestion.name] ?? '').trim()
    if (existing === suggestion.value) continue
    if (onlyEmpty && existing) continue
    group[suggestion.name] = suggestion.value
    applied.push(suggestion)
  }
  return { profile: next, applied }
}
