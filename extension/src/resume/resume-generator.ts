/**
 * Tailored resume -> files (spec section 13).
 *
 *   .docx: the master file with paragraph text replaced - exact layout.
 *   .pdf:  the same tailored text rendered in a simple template - approximate layout.
 *
 * Both are rebuilt on demand from the master + the session's edits, so the user's
 * in-panel corrections always reach the file, and nothing large lives in a session.
 */

import { applyDocxEdits, keepsLead, keepsTrail, planMiddle, sameLook } from './docx'
import { masterDocxBytes, masterParagraphs } from './resume-parser'
import { renderResumePdf } from './pdf'
import { resumeFileName } from '@/shared/utils/format'
import type { MasterResumeMeta } from '@/shared/types/settings'
import type { ParagraphEdit, ResumeParagraph, TextSpan } from '@/shared/types/resume'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PDF_MIME = 'application/pdf'

export interface GeneratedFile {
  fileName: string
  bytes: Uint8Array
  mime: string
}

/** Master paragraphs with edits applied; removed paragraphs dropped, inserted ones placed. */
export function applyParagraphEdits(
  paragraphs: readonly ResumeParagraph[],
  edits: readonly ParagraphEdit[],
): ResumeParagraph[] {
  const byId = new Map(edits.filter((edit) => !edit.insert).map((edit) => [edit.id, edit]))
  const masterById = new Map(paragraphs.map((p) => [p.id, p]))
  const insertsAfter = new Map<number, ParagraphEdit[]>()
  for (const edit of edits) {
    if (!edit.insert) continue
    insertsAfter.set(edit.insert.after, [...(insertsAfter.get(edit.insert.after) ?? []), edit])
  }

  return paragraphs.flatMap((p) => {
    const edit = byId.get(p.id)
    const own = !edit ? [p] : edit.removed ? [] : [withText(p, edit.text, edit.fresh)]
    const added = (insertsAfter.get(p.id) ?? []).flatMap((insert) => {
      const like = masterById.get(insert.insert!.like)
      return like ? [{ ...withText(like, insert.text, insert.fresh), id: insert.id }] : []
    })
    return [...own, ...added]
  })
}

function withText(p: ResumeParagraph, text: string, fresh = false): ResumeParagraph {
  const next: ResumeParagraph = { ...p, text }
  const spans = respan(p, text, fresh)
  if (spans) next.spans = spans
  else delete next.spans
  return next
}

/**
 * The new text's spans, worked out as the .docx writer formats runs: spans whose
 * text survives unchanged at the start or end keep their look (the name before a
 * new headline, a date, " | Company | Place"); the rewritten middle is formatted
 * by `planMiddle`, exactly as the .docx writer does it.
 */
function respan(original: ResumeParagraph, text: string, fresh: boolean): TextSpan[] | undefined {
  const spans = original.spans
  if (!spans) return undefined

  let rest = text
  let first = 0
  const lead: TextSpan[] = []
  while (first < spans.length - 1 && spans[first]!.text && rest.startsWith(spans[first]!.text) && (!fresh || keepsLead(spans[first]!.text, rest))) {
    lead.push(spans[first]!)
    rest = rest.slice(spans[first]!.text.length)
    first += 1
  }
  let last = spans.length - 1
  const trail: TextSpan[] = []
  while (last > first && spans[last]!.text && rest.endsWith(spans[last]!.text) && (!fresh || keepsTrail(spans[last]!.text, rest))) {
    trail.unshift(spans[last]!)
    rest = rest.slice(0, rest.length - spans[last]!.text.length)
    last -= 1
  }

  const middle = spans.slice(first, last + 1)
  const items = middle.map((span) => ({
    text: span.text,
    key: JSON.stringify([span.bold, Boolean(span.italic), span.sizePt ?? null, span.color ?? '', Boolean(span.caps)]),
    bold: span.bold,
  }))
  const rewritten: TextSpan[] = rest ? planMiddle(items, rest, fresh).map((piece) => ({ ...middle[piece.item]!, text: piece.text })) : []

  const merged: TextSpan[] = []
  for (const span of [...lead, ...rewritten, ...trail]) {
    if (!span.text) continue
    const previous = merged.at(-1)
    if (previous && sameLook(previous, span)) previous.text += span.text
    else merged.push({ ...span })
  }
  // One look all through, and it is the paragraph's own: no spans needed.
  const own: TextSpan = {
    text: '',
    bold: original.bold,
    ...(original.italic ? { italic: true } : {}),
    ...(original.sizePt ? { sizePt: original.sizePt } : {}),
    ...(original.color ? { color: original.color } : {}),
    ...(original.caps ? { caps: true } : {}),
  }
  return merged.length === 1 && sameLook(merged[0]!, own) ? undefined : merged
}

/**
 * Null when the master is not a .docx - there is no layout to preserve.
 * `owner`: the applicant's name, for "{First}_{Last}_CV.docx".
 */
export function generateDocx(master: MasterResumeMeta, edits: readonly ParagraphEdit[], owner: string): GeneratedFile | null {
  const bytes = masterDocxBytes(master)
  if (!bytes) return null
  return {
    fileName: resumeFileName(owner, 'docx'),
    bytes: applyDocxEdits(bytes, edits),
    mime: DOCX_MIME,
  }
}

export async function generatePdf(master: MasterResumeMeta, edits: readonly ParagraphEdit[], owner: string): Promise<GeneratedFile> {
  const fileName = resumeFileName(owner, 'pdf')
  const paragraphs = applyParagraphEdits(masterParagraphs(master), edits)
  return {
    fileName,
    bytes: await renderResumePdf(paragraphs, fileName.replace(/\.pdf$/, '')),
    mime: PDF_MIME,
  }
}
