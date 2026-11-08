/**
 * Approximate PDF output (spec sections 13 and the cover letter addendum).
 *
 * The .docx is the faithful output; this PDF is for sites that insist on one. It
 * renders the same (tailored) text with the document's own hints - headings, bullets,
 * bold, alignment, font size - in standard fonts. Content matches exactly; layout
 * only roughly.
 *
 * Standard PDF fonts only cover Windows-1252, so characters outside it are
 * transliterated where there is an obvious equivalent and replaced otherwise,
 * rather than failing the whole export.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import type { ResumeParagraph, TextSpan } from '@/shared/types/resume'

const PAGE = { width: 612, height: 792 } // US Letter, points
const MARGIN = 54
const INK = rgb(0.1, 0.1, 0.12)

interface Fonts {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  boldItalic: PDFFont
}

function fontFor(fonts: Fonts, span: { bold?: boolean; italic?: boolean }): PDFFont {
  if (span.bold && span.italic) return fonts.boldItalic
  if (span.bold) return fonts.bold
  if (span.italic) return fonts.italic
  return fonts.regular
}

function colorOf(hex: string | undefined): RGB {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return INK
  const n = parseInt(hex, 16)
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

/** A paragraph's look where a span does not set its own. */
interface Defaults {
  size: number
  bold?: boolean
  italic?: boolean
  color?: string
  caps?: boolean
}

class Writer {
  private page: PDFPage
  private y: number

  constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: Fonts,
  ) {
    this.page = pdf.addPage([PAGE.width, PAGE.height])
    this.y = PAGE.height - MARGIN
  }

  space(points: number) {
    this.y -= points
  }

  private newLine(lineHeight: number) {
    if (this.y - lineHeight < MARGIN) {
      this.page = this.pdf.addPage([PAGE.width, PAGE.height])
      this.y = PAGE.height - MARGIN
    }
    this.y -= lineHeight
  }

  /** A thin rule across the text width, just under the last line (a heading's bottom border). */
  rule() {
    const y = this.y - 4
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness: 0.8, color: INK })
    this.y -= 5
  }

  /**
   * Draws a paragraph of spans - each with its own weight, slant, size and colour -
   * word-wrapped, with its line breaks kept. A single tab with a short tail
   * ("Senior Engineer\t2019 - 2023") puts the tail flush right, as a right tab stop does.
   */
  paragraph(
    input: string | TextSpan[],
    options: Defaults & { align?: 'left' | 'center' | 'right'; indent?: number; bullet?: boolean },
  ) {
    let spans: TextSpan[] =
      typeof input === 'string' ? [{ text: input, bold: Boolean(options.bold) }] : input.map((span) => ({ ...span }))
    if (options.bold) spans = spans.map((span) => ({ ...span, bold: true }))

    const plain = spans.map((s) => s.text).join('')
    const tab = plain.indexOf('\t')
    let tail: TextSpan[] = []
    if (tab !== -1 && plain.indexOf('\t', tab + 1) === -1 && plain.length - tab <= 32 && !plain.includes('\n')) {
      ;[spans, tail] = splitSpans(spans, tab)
      tail = tail.map((s) => ({ ...s, text: s.text.replace(/^\t/, '') }))
    }
    spans = spans.map((s) => ({ ...s, text: s.text.replace(/\t+/g, '    ') }))

    const indent = options.indent ?? 0
    const width = PAGE.width - MARGIN * 2 - indent
    // The right-aligned tail (dates) is measured first and its room kept free, so a
    // long title wraps before it instead of running into it.
    const tailWords = tail.length ? wrapSpans(tail, this.fonts, options, width).flat() : []
    const tailWidth = tailWords.reduce((sum, word) => sum + word.width, 0)
    const lines = wrapSpans(spans, this.fonts, options, tailWidth ? Math.max(width * 0.4, width - tailWidth - 12) : width)

    lines.forEach((line, index) => {
      const tallest = Math.max(options.size, ...line.map((word) => word.size))
      this.newLine(tallest * 1.25)
      const lineWidth = line.reduce((sum, word) => sum + word.width, 0)
      let x = MARGIN + indent
      if (options.align === 'center') x = (PAGE.width - lineWidth) / 2
      if (options.align === 'right') x = PAGE.width - MARGIN - lineWidth

      if (options.bullet && index === 0) {
        this.page.drawText('•', { x: x - 10, y: this.y, size: options.size, font: this.fonts.regular, color: INK })
      }
      for (const word of line) {
        this.page.drawText(word.text, { x, y: this.y, size: word.size, font: word.font, color: word.color })
        x += word.width
      }

      if (index === 0 && tailWords.length) {
        let tx = PAGE.width - MARGIN - tailWidth
        for (const word of tailWords) {
          this.page.drawText(word.text, { x: tx, y: this.y, size: word.size, font: word.font, color: word.color })
          tx += word.width
        }
      }
    })
  }
}

async function createPdf(title: string): Promise<{ pdf: PDFDocument; fonts: Fonts }> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(title)
  pdf.setProducer('JobApply Assistant')
  const fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
  }
  return { pdf, fonts }
}

/**
 * Renders resume paragraphs (already tailored) to PDF bytes, following the
 * document's own formatting where it states it - sizes, bold, italic, colour,
 * caps, rules under headings, spacing - and sensible defaults where it does not.
 */
export async function renderResumePdf(paragraphs: readonly ResumeParagraph[], title: string): Promise<Uint8Array> {
  const { pdf, fonts } = await createPdf(title)
  const writer = new Writer(pdf, fonts)

  paragraphs.forEach((p, index) => {
    const look = { bold: p.bold, ...(p.italic ? { italic: true } : {}), ...(p.color ? { color: p.color } : {}), ...(p.caps ? { caps: true } : {}) }
    const content = p.spans?.length ? p.spans : [{ text: p.text, ...look }]
    const before = (fallback: number) => (index > 0 ? Math.min(p.spaceBeforePt ?? fallback, 18) : 0)
    const after = (fallback: number) => Math.min(p.spaceAfterPt ?? fallback, 14)

    switch (p.role) {
      case 'title':
        writer.paragraph(content, { ...look, size: clamp(p.sizePt ?? 20, 14, 28), bold: p.bold || !p.spans, align: p.align })
        writer.space(after(3))
        break
      case 'subtitle':
        writer.space(before(0))
        writer.paragraph(content, { ...look, size: clamp(p.sizePt ?? 11, 9, 16), align: p.align })
        writer.space(after(3))
        break
      case 'heading':
        writer.space(before(10))
        writer.paragraph(content, { ...look, size: clamp(p.sizePt ?? 12, 10, 16), bold: true, align: p.align })
        if (p.borderBottom) writer.rule()
        writer.space(after(4))
        break
      case 'bullet':
        writer.space(before(0))
        writer.paragraph(content, { ...look, size: bodySize(p), indent: 16, bullet: true })
        writer.space(after(1.5))
        break
      default: {
        // A short, all-bold line opening the document is a name line styled by hand.
        const nameLine = index === 0 && p.bold && p.text.length < 50 && !p.spans
        writer.space(before(p.bold && index > 0 ? 3 : 0))
        writer.paragraph(content, {
          ...look,
          size: nameLine ? clamp(p.sizePt ?? 18, 14, 28) : bodySize(p),
          align: p.align,
        })
        if (p.borderBottom) writer.rule()
        writer.space(after(2))
      }
    }
  })

  return pdf.save()
}

function bodySize(p: ResumeParagraph): number {
  return clamp(p.sizePt ?? 10.5, 8, 12)
}

/** Renders a plain-text letter with a simple name/contact header. */
export async function renderLetterPdf(
  text: string,
  header: { name: string; contact: string },
  title: string,
): Promise<Uint8Array> {
  const { pdf, fonts } = await createPdf(title)
  const writer = new Writer(pdf, fonts)

  if (header.name) writer.paragraph(header.name, { size: 16, bold: true })
  if (header.contact) writer.paragraph(header.contact, { size: 9.5 })
  if (header.name || header.contact) writer.space(14)

  writer.paragraph(
    // English, like the letter: other locales' month names are not in the PDF's standard font.
    new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    { size: 10.5 },
  )
  writer.space(10)

  for (const block of text.split(/\n{2,}/)) {
    for (const line of block.split('\n')) writer.paragraph(line, { size: 10.5 })
    writer.space(8)
  }

  return pdf.save()
}

// ---------------------------------------------------------------------------

interface PlacedWord {
  text: string
  font: PDFFont
  size: number
  color: RGB
  width: number
}

/** Line breaks inside a paragraph, however the document wrote them. */
const LINE_BREAK = new RegExp(`\\r\\n?|[\\n\\v${String.fromCharCode(0x2028, 0x2029, 0x85)}]`, 'g')

/**
 * Word-wraps spans, keeping each word's font, size and colour. Each word carries
 * its trailing space. Line breaks are split out *before* characters are checked
 * against the font, which has no glyph for them (they used to print as "?").
 */
function wrapSpans(spans: TextSpan[], fonts: Fonts, defaults: Defaults, width: number): PlacedWord[][] {
  const lines: PlacedWord[][] = [[]]
  let lineWidth = 0

  for (const span of spans) {
    const font = fontFor(fonts, { bold: span.bold, italic: span.italic ?? defaults.italic })
    const size = span.sizePt ? clamp(span.sizePt, 6, 30) : defaults.size
    const color = colorOf(span.color ?? defaults.color)
    const caps = span.caps ?? defaults.caps
    const text = (caps ? span.text.toUpperCase() : span.text).replace(LINE_BREAK, '\n')

    // Split into words and newlines, keeping spaces attached to the preceding word.
    for (const raw of text.split(/(\n)|(?<= )/)) {
      if (raw === undefined || raw === '') continue
      if (raw === '\n') {
        lines.push([])
        lineWidth = 0
        continue
      }
      for (const token of fitToWidth(sanitize(raw, font), font, size, width)) {
        const wordWidth = font.widthOfTextAtSize(token, size)
        const current = lines[lines.length - 1]!
        if (lineWidth + font.widthOfTextAtSize(token.trimEnd(), size) > width && current.length) {
          // Drop the trailing space of the line being closed so right/centre alignment is exact.
          const lastWord = current[current.length - 1]!
          lastWord.text = lastWord.text.trimEnd()
          lastWord.width = lastWord.font.widthOfTextAtSize(lastWord.text, lastWord.size)
          lines.push([{ text: token, font, size, color, width: wordWidth }])
          lineWidth = wordWidth
        } else {
          current.push({ text: token, font, size, color, width: wordWidth })
          lineWidth += wordWidth
        }
      }
    }
  }
  return lines
}

/** A word wider than the line (a long URL) is cut into pieces that fit, instead of running off the page. */
function fitToWidth(token: string, font: PDFFont, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(token.trimEnd(), size) <= width) return [token]
  const pieces: string[] = []
  let piece = ''
  for (const char of token) {
    if (piece && font.widthOfTextAtSize(piece + char, size) > width) {
      pieces.push(piece)
      piece = ''
    }
    piece += char
  }
  if (piece) pieces.push(piece)
  return pieces
}

/** Splits spans at a character offset into [before, from offset]. */
function splitSpans(spans: TextSpan[], offset: number): [TextSpan[], TextSpan[]] {
  const before: TextSpan[] = []
  const after: TextSpan[] = []
  let position = 0
  for (const span of spans) {
    const end = position + span.text.length
    if (end <= offset) before.push(span)
    else if (position >= offset) after.push(span)
    else {
      before.push({ ...span, text: span.text.slice(0, offset - position) })
      after.push({ ...span, text: span.text.slice(offset - position) })
    }
    position = end
  }
  return [before, after]
}

const TRANSLITERATE: Record<string, string> = {
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '−': '-',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '→': '->',
  '←': '<-',
  '✓': 'v',
  '▪': '•',
  '●': '•',
}

function sanitize(text: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet())
  let out = ''
  for (const char of text) {
    const mapped = TRANSLITERATE[char] ?? char
    for (const c of mapped) out += supported.has(c.codePointAt(0)!) ? c : '?'
  }
  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
