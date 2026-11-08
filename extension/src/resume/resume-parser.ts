/**
 * Master resume intake (spec section 10).
 *
 * A .docx is kept whole: its bytes are stored so every tailored resume can be the
 * same file with only paragraph text changed. Its paragraphs are read here once so
 * the user can see exactly what the model will be shown.
 *
 * Plain text and Markdown are read directly. PDF text extraction is not attempted -
 * a mangled extraction silently tailored is worse than asking for a paste.
 */

import { paragraphsFromText, paragraphsToText, readDocxParagraphs } from './docx'
import { base64ToBytes, bytesToBase64 } from '@/shared/utils/bytes'
import type { MasterResumeMeta } from '@/shared/types/settings'
import type { ResumeParagraph } from '@/shared/types/resume'

export interface ExtractedResume {
  meta: MasterResumeMeta
  /** Message to surface in the UI, if any. */
  note: string | null
}

export async function extractResume(file: File): Promise<ExtractedResume> {
  const name = file.name.toLowerCase()
  const base = {
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    uploadedAt: Date.now(),
  }

  if (name.endsWith('.docx')) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const paragraphs = readDocxParagraphs(bytes)
    if (!paragraphs.length) throw new Error(`"${file.name}" has no readable text in its main body.`)
    return {
      meta: {
        ...base,
        format: 'docx',
        docxBase64: bytesToBase64(bytes),
        text: paragraphsToText(paragraphs),
        textIsApproximate: false,
      },
      note: null,
    }
  }

  if (file.type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
    return {
      meta: { ...base, format: 'text', text: await file.text(), textIsApproximate: false },
      note: 'Plain-text master: tailored resumes will be PDF only. Upload a .docx to keep your Word layout.',
    }
  }

  if (name.endsWith('.pdf')) {
    return {
      meta: { ...base, format: 'text', text: '', textIsApproximate: true },
      note: `"${file.name}" was saved, but PDF text is not extracted. Paste your resume text below - or better, upload the .docx so your layout is preserved.`,
    }
  }

  throw new Error('Unsupported file type. Use .docx (recommended), .txt, .md or .pdf.')
}

/** The paragraphs tailoring works on, whatever format the master is in. */
export function masterParagraphs(meta: MasterResumeMeta): ResumeParagraph[] {
  if (meta.format === 'docx' && meta.docxBase64) {
    return readDocxParagraphs(base64ToBytes(meta.docxBase64))
  }
  return paragraphsFromText(meta.text)
}

export function masterDocxBytes(meta: MasterResumeMeta): Uint8Array | null {
  return meta.format === 'docx' && meta.docxBase64 ? base64ToBytes(meta.docxBase64) : null
}
