/**
 * Plain text of a PDF or .docx file - used to paste a cover letter ChatGPT created
 * as a file into a form's text box. Paragraphs are separated by a blank line.
 */

import { paragraphsToText, readDocxParagraphs } from '@/resume/docx'

export async function documentText(bytes: Uint8Array, kind: 'pdf' | 'docx'): Promise<string> {
  if (kind === 'docx') return tidy(paragraphsToText(readDocxParagraphs(bytes)).replace(/\n/g, '\n\n'))
  return tidy(await pdfText(bytes))
}

/** Lines from the PDF's text positions; a wider gap than usual starts a new paragraph. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  // Loaded on first use: the PDF reader is large, and only needed for this.
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  // pdf.js takes ownership of the buffer it is given; hand it a copy.
  const task = pdfjs.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  const pages: TextItem[][] = []
  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const content = await (await doc.getPage(pageNumber)).getTextContent()
      pages.push(content.items.flatMap((item) => ('str' in item ? [{ str: item.str, transform: item.transform as number[], height: item.height }] : [])))
    }
  } finally {
    await task.destroy()
  }
  return paragraphsFromTextItems(pages)
}

export interface TextItem {
  str: string
  transform: number[]
  height: number
}

/**
 * Rebuilds paragraphs from pdf.js text pieces: pieces at the same height form a
 * line; a gap clearly wider than a line starts a new paragraph.
 */
export function paragraphsFromTextItems(pages: TextItem[][]): string {
  const paragraphs: string[] = []
  for (const items of pages) {
    const lines: { y: number; height: number; text: string }[] = []
    for (const item of items) {
      const y = item.transform[5]!
      const last = lines[lines.length - 1]
      if (last && Math.abs(last.y - y) < 2) last.text += item.str
      else lines.push({ y, height: Math.abs(item.transform[3]!) || item.height || 10, text: item.str })
    }
    let current = ''
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const gap = i > 0 ? lines[i - 1]!.y - line.y : 0
      if (i > 0 && gap > line.height * 1.8 && current.trim()) {
        paragraphs.push(current.trim())
        current = ''
      }
      const text = line.text.trim()
      if (!text) continue
      current = !current ? text : current.endsWith('-') ? `${current.slice(0, -1)}${text}` : `${current} ${text}`
    }
    if (current.trim()) paragraphs.push(current.trim())
  }
  return paragraphs.join('\n\n')
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
