/**
 * The master resume's parts, and tailored content put back into them.
 *
 * The user's chat writes only the parts that change per job - the headline, the
 * summary, the skills, and each position's title and bullets - and this module
 * places them into the master's own paragraphs. Company names, locations, dates,
 * education and everything else stay exactly as in the master.
 *
 *   analyzeResume(paragraphs)        -> where each part is
 *   contentEdits(layout, content)    -> paragraph edits (replace / add / remove)
 *
 * Added paragraphs copy the formatting of one of the same kind in that part (a
 * bullet of the same job, a category line of the skills), so the .docx keeps its
 * look whatever the counts are.
 */

import { INSERT_ID_BASE, type ParagraphEdit, type ResumeParagraph } from '@/shared/types/resume'

export interface ResumeBlock {
  heading: ResumeParagraph
  items: ResumeParagraph[]
}

export interface ResumeJob {
  /** The position's own lines (title, company, location, dates) before its bullets. */
  header: ResumeParagraph[]
  /**
   * Where the job title is: which header paragraph, and which part of its text.
   * `fullEnd`: the end of the title together with a technology tagline right after
   * it ("Senior Developer | React, Node.js & AWS"), replaced when the new title has one too.
   */
  title?: { paragraph: ResumeParagraph; start: number; end: number; fullEnd: number }
  /** Bullets / description paragraphs. */
  content: ResumeParagraph[]
  /** One line describing the position, for the chat ("Full-Stack Developer | Boozt | Malmo, SE | 2021 - Present"). */
  label: string
}

export interface ResumeLayout {
  name?: ResumeParagraph
  headline?: ResumeParagraph
  /** The contact line under the name; a headline added to a resume without one copies its style. */
  contact?: ResumeParagraph
  /** A headline that is the second line of the name's own paragraph (name, line break, title). */
  headlineInName?: { start: number; end: number }
  summary?: ResumeBlock
  skills?: ResumeBlock & { style: 'categories' | 'lines' }
  experience?: { heading: ResumeParagraph; jobs: ResumeJob[] }
}

export interface TailoredContent {
  headline?: string
  summary?: string
  skills?: { category: string; items: string[] }[]
  experience?: { position?: number; title?: string; bullets?: string[] }[]
  coverLetter?: string
}

const SECTION_WORDS =
  /summary|profile|about|objective|overview|skill|technolog|competenc|stack|expertise|tools|experience|employment|history|education|certific|project|achievement|award|language|interest|publication|volunteer|reference|course|training/i
const SUMMARY = /summary|profile|about me|objective|overview/i
const SKILLS = /skill|technolog|competenc|stack|expertise|tools/i
const EXPERIENCE = /experience|employment|work history|career history|professional background/i
const TITLE_WORDS =
  /\b(engineer|developer|programmer|architect|lead|manager|consultant|analyst|designer|scientist|specialist|director|head|intern|administrator|officer|technician|coordinator|devops|sre|cto|founder|tester|qa|owner)\b/i
const CONTACT = /@|https?:|www\.|linkedin|github|\+?\d[\d\s().-]{7,}/i
/** A line break inside a paragraph (Word: line break; some writers use these separators). */
const LINE_BREAK = new RegExp(`[\\n\\v${String.fromCharCode(0x2028)}]`)
const BULLET_CHAR = /^\s*[•·▪●◦\-–*]\s+/
const YEAR = /\b(19|20)\d{2}\b|present|current/i

export function isSectionHeading(p: ResumeParagraph): boolean {
  if (p.role === 'heading') return true
  const text = p.text.trim()
  if (!text || text.length > 40 || p.role === 'bullet' || /[.:]$/.test(text)) return false
  const styled = p.bold || p.caps || (text === text.toUpperCase() && /[A-Z]/.test(text))
  return styled && SECTION_WORDS.test(text)
}

export function analyzeResume(paragraphs: readonly ResumeParagraph[]): ResumeLayout {
  const layout: ResumeLayout = {}
  const firstHeading = paragraphs.findIndex(isSectionHeading)
  const top = firstHeading === -1 ? [] : paragraphs.slice(0, firstHeading)

  const name = top.find((p) => p.role === 'title') ?? top[0]
  if (name) layout.name = name
  const headline =
    top.find((p) => p.role === 'subtitle') ??
    top.find((p) => p !== name && p.text.trim().length <= 160 && !CONTACT.test(p.text) && p.role !== 'bullet')
  if (headline) layout.headline = headline
  // "AGAMYRAT AKMYRADOV <line break> Senior Software Engineer | Full Stack Developer" in one paragraph.
  if (!headline && name) {
    const lineBreak = name.text.search(LINE_BREAK)
    if (lineBreak > 0) {
      const start = lineBreak + 1
      const next = name.text.slice(start).search(LINE_BREAK)
      const end = next === -1 ? name.text.length : start + next
      const line = name.text.slice(start, end)
      if (line.trim() && !CONTACT.test(line)) layout.headlineInName = { start, end }
    }
  }
  const contact = top.find((p) => p !== name && p !== headline && CONTACT.test(p.text))
  if (contact) layout.contact = contact

  const blocks: ResumeBlock[] = []
  for (const p of paragraphs) {
    if (isSectionHeading(p)) blocks.push({ heading: p, items: [] })
    else blocks.at(-1)?.items.push(p)
  }

  for (const block of blocks) {
    const heading = block.heading.text
    if (!layout.experience && EXPERIENCE.test(heading)) {
      layout.experience = { heading: block.heading, jobs: jobsOf(block.items) }
    } else if (!layout.summary && SUMMARY.test(heading)) {
      layout.summary = block
    } else if (!layout.skills && SKILLS.test(heading)) {
      const categorised = block.items.some((p) => skillKind(p) === 'category') && block.items.some((p) => skillKind(p) === 'bullet')
      layout.skills = { ...block, style: categorised ? 'categories' : 'lines' }
    }
  }
  return layout
}

function isContent(p: ResumeParagraph): boolean {
  return p.role === 'bullet' || BULLET_CHAR.test(p.text) || (p.text.trim().length > 160 && !YEAR.test(p.text.slice(0, 80)))
}

/** Positions: header lines, then their bullets; a header line after bullets starts the next position. */
function jobsOf(items: readonly ResumeParagraph[]): ResumeJob[] {
  const jobs: { header: ResumeParagraph[]; content: ResumeParagraph[] }[] = []
  for (const p of items) {
    const current = jobs.at(-1)
    if (isContent(p)) {
      if (current) current.content.push(p)
      else jobs.push({ header: [], content: [p] })
    } else if (!current || current.content.length) {
      jobs.push({ header: [p], content: [] })
    } else {
      current.header.push(p)
    }
  }
  return jobs
    .filter((job) => job.header.length)
    .map((job) => {
      const title = findTitle(job.header)
      return {
        ...job,
        ...(title ? { title } : {}),
        label: job.header.map((p) => p.text.replace(/\t+/g, ' | ').replace(/\s+/g, ' ').trim()).join(' | '),
      }
    })
}

/**
 * The job title inside a position's header: the part between separators ("|",
 * " - ", " at "...) that reads like a title. The date after a tab is never part of it.
 */
function findTitle(header: readonly ResumeParagraph[]): ResumeJob['title'] | undefined {
  for (const paragraph of header) {
    const text = paragraph.text
    const end = text.includes('\t') ? text.indexOf('\t') : text.length
    const parts: { start: number; end: number }[] = []
    const separator = /\s*(?:\||–|—|\s-\s|\s@\s|\sat\s)\s*/g
    let start = 0
    for (const match of text.slice(0, end).matchAll(separator)) {
      parts.push({ start, end: match.index! })
      start = match.index! + match[0].length
    }
    parts.push({ start, end })
    for (const [index, part] of parts.entries()) {
      const raw = text.slice(part.start, part.end)
      if (!TITLE_WORDS.test(raw) || (parts.length === 1 && YEAR.test(raw))) continue
      // Trim the surrounding spaces so they stay as they are.
      const lead = raw.length - raw.trimStart().length
      const trail = (s: string) => s.length - s.trimEnd().length
      const titleEnd = part.end - trail(raw)
      // A technology tagline after the title ("| Python, React & Cloud Applications") belongs to it.
      let fullEnd = titleEnd
      for (const next of parts.slice(index + 1)) {
        const tag = text.slice(next.start, next.end)
        if (!isTagline(tag)) break
        fullEnd = next.end - trail(tag)
      }
      return { paragraph, start: part.start + lead, end: titleEnd, fullEnd }
    }
  }
  return undefined
}

const TECH =
  /\b(react|angular|vue(\.js)?|node(\.js)?|nestjs|next\.js|express|typescript|javascript|python|django|flask|fastapi|java|kotlin|golang|rust|php|laravel|ruby|rails|\.net|asp\.net|c#|aws|azure|gcp|cloud|apis?|rest|graphql|sql|postgre\w*|mysql|mongo\w*|redis|kafka|microservices|services|docker|kubernetes|devops|frontend|backend|full[- ]stack|data|ml|ai|performance|architecture|integration|applications?)\b/i

/** "Python, React & Cloud Applications" - a list of technologies, not a company or a place. */
function isTagline(text: string): boolean {
  return /[,&]/.test(text) && TECH.test(text) && !YEAR.test(text)
}

type Kind = 'category' | 'bullet' | 'line'

function skillKind(p: ResumeParagraph): Kind {
  if (p.role === 'bullet' || BULLET_CHAR.test(p.text)) return 'bullet'
  if (/:\s*$/.test(p.text)) return 'category'
  return 'line'
}

/** A part's paragraphs are "deeper" in this order; a deeper new line is added rather than taking a shallower slot. */
const DEPTH: Record<Kind, number> = { category: 0, line: 1, bullet: 2 }

// ---------------------------------------------------------------------------
// Content -> edits
// ---------------------------------------------------------------------------

export function contentEdits(layout: ResumeLayout, content: TailoredContent): { edits: ParagraphEdit[]; notes: string[] } {
  const edits: ParagraphEdit[] = []
  const notes: string[] = []
  let nextId = INSERT_ID_BASE

  const replace = (p: ResumeParagraph, text: string) => {
    if (text.trim() && text !== p.text) edits.push({ id: p.id, original: p.text, text })
  }

  /**
   * Fits new lines into a part's paragraphs, in order: a slot of the same kind is
   * rewritten, a missing one is added (formatted like one of its kind), and slots
   * left over are removed.
   */
  const fit = (slots: readonly ResumeParagraph[], lines: { kind: Kind; text: string }[], anchor: ResumeParagraph, kindOf: (p: ResumeParagraph) => Kind) => {
    const prefixOf = (p: ResumeParagraph) => (p.role === 'bullet' ? '' : (BULLET_CHAR.exec(p.text)?.[0] ?? ''))
    let at = 0
    let after = anchor.id
    for (const line of lines) {
      while (at < slots.length && kindOf(slots[at]!) !== line.kind && DEPTH[line.kind] <= DEPTH[kindOf(slots[at]!)]) {
        edits.push({ id: slots[at]!.id, original: slots[at]!.text, text: '', removed: true })
        at += 1
      }
      const slot = slots[at]
      if (slot && kindOf(slot) === line.kind) {
        replace(slot, prefixOf(slot) + line.text)
        after = slot.id
        at += 1
        continue
      }
      const like = slots.find((p) => kindOf(p) === line.kind)
      if (!like) {
        notes.push(`Left out (no line of that kind in your resume to copy): ${line.text.slice(0, 60)}`)
        continue
      }
      edits.push({ id: nextId++, original: '', text: prefixOf(like) + line.text, insert: { after, like: like.id } })
    }
    for (; at < slots.length; at += 1) edits.push({ id: slots[at]!.id, original: slots[at]!.text, text: '', removed: true })
  }

  if (content.headline?.trim()) {
    if (layout.headline) {
      replace(layout.headline, content.headline.trim())
    } else if (layout.name && layout.headlineInName) {
      // Only the title line changes; the name and the line break stay.
      const { start, end } = layout.headlineInName
      replace(layout.name, layout.name.text.slice(0, start) + content.headline.trim() + layout.name.text.slice(end))
    } else if (layout.name && layout.contact) {
      // No title line under the name yet: add one there, in the contact line's style.
      edits.push({ id: nextId++, original: '', text: content.headline.trim(), insert: { after: layout.name.id, like: layout.contact.id } })
    } else {
      notes.push('Could not find where your name is in the resume, so the new headline was not added.')
    }
  }

  if (content.summary?.trim() && layout.summary) {
    const paragraphs = content.summary.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean)
    const slots = layout.summary.items
    fit(slots, paragraphs.map((text) => ({ kind: 'line' as const, text })), layout.summary.heading, () => 'line')
  }

  if (content.skills?.length && layout.skills) {
    const skills = layout.skills
    const lines =
      skills.style === 'categories'
        ? content.skills.flatMap((group) => [
            { kind: 'category' as const, text: `${group.category.trim().replace(/:$/, '')}:` },
            ...group.items.map((item) => ({ kind: 'bullet' as const, text: item.trim() })),
          ])
        : content.skills.map((group) => ({
            kind: (skills.items.some((p) => skillKind(p) === 'line') ? 'line' : 'bullet') as Kind,
            text: `${group.category.trim().replace(/:$/, '')}: ${group.items.map((item) => item.trim()).join(', ')}`,
          }))
    fit(skills.items, lines, skills.heading, skillKind)
  }

  if (content.experience?.length && layout.experience) {
    const jobs = layout.experience.jobs
    content.experience.forEach((entry, index) => {
      const job = jobs[(entry.position ?? index + 1) - 1]
      if (!job) {
        notes.push(`The reply has a position ${entry.position ?? index + 1} your resume does not have; it was left out.`)
        return
      }
      if (entry.title?.trim()) {
        if (job.title) {
          const { paragraph, start } = job.title
          // A new title with its own tagline replaces the old tagline too, instead of
          // ending up as "New Title | new tech | old tech".
          const end = /\s(?:\||–|—)\s/.test(entry.title) ? job.title.fullEnd : job.title.end
          const already = edits.find((edit) => edit.id === paragraph.id)
          const base = already?.text ?? paragraph.text
          const text = base.slice(0, start) + entry.title.trim() + base.slice(end)
          if (already) already.text = text
          else replace(paragraph, text)
        } else {
          notes.push(`Could not find the job title in "${job.label.slice(0, 60)}", so it was kept.`)
        }
      }
      if (entry.bullets?.length) {
        const bulleted = job.content.some((p) => p.role === 'bullet' || BULLET_CHAR.test(p.text)) || !job.content.length
        const kind: Kind = bulleted ? 'bullet' : 'line'
        fit(job.content, entry.bullets.map((text) => ({ kind, text: text.trim() })).filter((line) => line.text), job.header.at(-1)!, (p) =>
          p.role === 'bullet' || BULLET_CHAR.test(p.text) ? 'bullet' : 'line',
        )
      }
    })
  }

  // The chat writes new text, not rewrites of the old sentences: it takes each
  // paragraph's plain look instead of the old text's bold words.
  for (const edit of edits) if (!edit.removed) edit.fresh = true
  return { edits, notes }
}
