/**
 * Tailoring in the user's own chat, as text: the chat writes the parts of the CV
 * that change per job (and the cover letter); the extension builds the files.
 *
 *   message: the job + the user's positions + the exact JSON shape to reply in
 *   reply:   that JSON -> TailoredContent (sections.ts puts it into the master)
 *
 * The chat already knows the user's CV and instructions, so the message carries
 * no CV text - only the position list, so the reply's positions line up with
 * the master's, and companies, places and dates stay untouched.
 */

import { extractJson } from '@/ai/prompts'
import { AIReplyError } from '@/ai/ai-provider.interface'
import type { ResumeLayout, TailoredContent } from './sections'

export function contentMessage(
  layout: ResumeLayout,
  job: { company: string; position: string; description: string },
  extra?: string,
): string {
  const positions = layout.experience?.jobs ?? []
  const categories =
    layout.skills?.style === 'categories'
      ? layout.skills.items.filter((p) => /:\s*$/.test(p.text)).map((p) => p.text.trim().replace(/:$/, ''))
      : (layout.skills?.items ?? []).map((p) => /^([^:]{2,40}):/.exec(p.text)?.[1]?.trim()).filter((c): c is string => Boolean(c))

  return [
    `Tailor my CV for the job below. Write only the parts listed here - I put them into my CV and make the PDF myself, so do NOT create files or links.`,
    extra?.trim() ?? '',
    `Reply with JSON only, in one code block, exactly in this shape:

{
  "headline": "the line under my name: target title | key technologies, e.g. Lead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture",
  "summary": "my professional summary for this job, 3-5 sentences",
  "skills": [{ "category": "Frontend", "items": ["React, Vue.js, TypeScript", "..."] }],
  "experience": [{ "position": 1, "title": "my title for this position", "bullets": ["...", "..."] }],
  "coverLetter": "the cover letter, paragraphs separated by a blank line, signed with my name"
}`,
    positions.length
      ? `My positions, most recent first. Give one "experience" entry per position, with its number. Do not change the company, location or dates - only the title and the bullets:\n${positions
          .map((job, index) => `${index + 1}. ${job.label}`)
          .join('\n')}`
      : '',
    categories.length ? `My skills categories now: ${categories.join(', ')}. Keep, reorder or rename them for this job.` : '',
    `Rules:
- Only facts from my CV: no new employers, dates, degrees, certifications or invented numbers.
- 4-6 bullets for recent positions, fewer for older ones. Each bullet: what I built, with which technologies, and the result.
- Use the job description's keywords where they truly match my experience.
- Plain text inside the JSON: no Markdown, no bullet characters.`,
    `Company: ${job.company.trim() || 'unknown'}\nPosition: ${job.position.trim() || 'unknown'}\n\nJob description:\n${job.description.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The chat's reply as content. Lenient about wording, strict about having something usable. */
export function parseContent(reply: string): TailoredContent {
  let raw: unknown
  try {
    raw = extractJson(reply)
  } catch {
    raw = null
  }
  if (!raw || typeof raw !== 'object') {
    throw new AIReplyError('The chat did not reply with the JSON the extension asked for. Press Tailor again (or Redo).')
  }
  const data = raw as Record<string, unknown>
  const text = (value: unknown) => (typeof value === 'string' ? clean(value) : '')
  const list = (value: unknown) =>
    Array.isArray(value) ? value.map((item) => (typeof item === 'string' ? clean(item).replace(/^[•·▪●◦\-–*]\s+/, '') : '')).filter(Boolean) : []

  const content: TailoredContent = {}
  const headline = text(data.headline ?? data.title ?? data.mainTitle)
  if (headline) content.headline = headline.replace(/\n+/g, ' ')
  const summary = text(data.summary ?? data.professionalSummary)
  if (summary) content.summary = summary

  const skills = data.skills ?? data.technicalSkills
  if (Array.isArray(skills)) {
    content.skills = skills
      .map((group) => {
        if (typeof group === 'string') {
          const [category, rest] = splitOnce(clean(group), ':')
          return { category, items: rest ? [rest] : [] }
        }
        const g = (group ?? {}) as Record<string, unknown>
        const items = Array.isArray(g.items) ? list(g.items) : text(g.items) ? [text(g.items)] : []
        return { category: text(g.category ?? g.name), items }
      })
      .filter((group) => group.category && group.items.length)
  } else if (skills && typeof skills === 'object') {
    content.skills = Object.entries(skills as Record<string, unknown>)
      .map(([category, items]) => ({ category: clean(category), items: Array.isArray(items) ? list(items) : text(items) ? [text(items)] : [] }))
      .filter((group) => group.items.length)
  }

  const experience = data.experience ?? data.professionalExperience
  if (Array.isArray(experience)) {
    content.experience = experience.map((entry, index) => {
      const e = (entry ?? {}) as Record<string, unknown>
      const position = Number(e.position ?? e.number ?? index + 1)
      return {
        position: Number.isInteger(position) && position > 0 ? position : index + 1,
        ...(text(e.title) ? { title: text(e.title).replace(/\n+/g, ' ') } : {}),
        bullets: list(e.bullets ?? e.points ?? e.achievements),
      }
    })
  }

  const letter = text(data.coverLetter ?? data.cover_letter ?? data.letter)
  if (letter) content.coverLetter = letter

  if (!content.headline && !content.summary && !content.skills?.length && !content.experience?.length) {
    throw new AIReplyError('The chat replied, but without a headline, summary, skills or experience. Press Tailor again (or Redo).')
  }
  return content
}

function clean(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator)
  return index === -1 ? [text, ''] : [text.slice(0, index).trim(), text.slice(index + 1).trim()]
}
