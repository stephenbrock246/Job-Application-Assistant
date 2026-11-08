/**
 * Layout-preserving DOCX editing.
 *
 * A .docx is a zip of XML parts; the visible text lives in `word/document.xml` as
 * paragraphs (`w:p`) made of runs (`w:r`), each run carrying its own formatting
 * (`w:rPr`) and text (`w:t`, `w:tab`, `w:br`).
 *
 * Tailoring changes *text only*:
 *   - every paragraph and its properties (style, numbering, spacing, tabs) stay;
 *   - an unchanged prefix/suffix of a rewritten paragraph (a bold "Skills:" label,
 *     an italic date) keeps its own run;
 *   - inside the rewritten middle, phrases that were specially formatted in the
 *     original (bold "React", "Node.js") keep that formatting wherever they still
 *     appear; the rest takes the paragraph's predominant run format;
 *   - every other part of the package (styles, numbering, headers, fonts, images)
 *     is copied byte for byte.
 *
 * Reading resolves formatting the way Word does - document defaults, then the
 * paragraph style's `basedOn` chain, then direct formatting - because real resumes
 * keep most of it in styles, often with numeric style ids ("15" = Title).
 *
 * Uses DOMParser/XMLSerializer, so it runs in the side panel (and jsdom), not the
 * service worker.
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import type { ParagraphEdit, ParagraphRole, ResumeParagraph, TextSpan } from '@/shared/types/resume'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const XML_NS = 'http://www.w3.org/XML/1998/namespace'
const DOCUMENT_PART = 'word/document.xml'
const STYLES_PART = 'word/styles.xml'

/** Run children that hold text. Everything else in a run (rPr, drawings, fields) is kept. */
const TEXT_NODES = new Set(['t', 'tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen'])

interface ParsedDocx {
  files: Record<string, Uint8Array>
  doc: Document
  declaration: string
  paragraphs: Element[]
  styles: StyleSheet
}

function parseXml(xml: string, part: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${part} could not be parsed.`)
  return doc
}

function parseDocx(bytes: Uint8Array): ParsedDocx {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('This file is not a valid .docx (it could not be unzipped).')
  }
  const part = files[DOCUMENT_PART]
  if (!part) throw new Error('This .docx has no word/document.xml - it may be a different format renamed to .docx.')

  const xml = strFromU8(part)
  const declaration = /^<\?xml[^>]*\?>/.exec(xml)?.[0] ?? ''
  const doc = parseXml(xml, DOCUMENT_PART)
  const stylesPart = files[STYLES_PART]
  const styles = new StyleSheet(stylesPart ? parseXml(strFromU8(stylesPart), STYLES_PART) : null)

  return { files, doc, declaration, paragraphs: Array.from(doc.getElementsByTagNameNS(W, 'p')), styles }
}

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

function wChild(parent: Element | null | undefined, name: string): Element | null {
  if (!parent) return null
  for (const child of Array.from(parent.children)) {
    if (child.namespaceURI === W && child.localName === name) return child
  }
  return null
}

function wVal(element: Element | null): string | null {
  return element?.getAttributeNS(W, 'val') ?? element?.getAttribute('w:val') ?? null
}

/** A toggle property (`<w:b/>`, `<w:caps w:val="0"/>`): undefined when not stated. */
function toggle(rPr: Element | null, name: string): boolean | undefined {
  const element = wChild(rPr, name)
  if (!element) return undefined
  const val = wVal(element)
  return val === null || !['0', 'false', 'off'].includes(val)
}

function halfPoints(rPr: Element | null): number | undefined {
  const val = wVal(wChild(rPr, 'sz'))
  const n = val ? Number(val) : NaN
  return Number.isFinite(n) ? n / 2 : undefined
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

interface RunFormat {
  bold?: boolean
  italic?: boolean
  caps?: boolean
  sizePt?: number
  color?: string
}

/** Paragraph properties the PDF reproduces: a rule under it, and its spacing. */
interface BlockFormat {
  borderBottom?: boolean
  spaceBeforePt?: number
  spaceAfterPt?: number
}

interface ParagraphFormat extends RunFormat, BlockFormat {
  name: string
  align?: ResumeParagraph['align']
  numbered: boolean
  outline: boolean
}

function mergeRun(base: RunFormat, rPr: Element | null): RunFormat {
  const bold = toggle(rPr, 'b')
  const italic = toggle(rPr, 'i')
  const caps = toggle(rPr, 'caps')
  const sizePt = halfPoints(rPr)
  const colorVal = wVal(wChild(rPr, 'color'))
  const color = colorVal && /^[0-9a-f]{6}$/i.test(colorVal) ? colorVal.toUpperCase() : colorVal === 'auto' ? '' : undefined
  return {
    ...base,
    ...(bold !== undefined ? { bold } : {}),
    ...(italic !== undefined ? { italic } : {}),
    ...(caps !== undefined ? { caps } : {}),
    ...(sizePt !== undefined ? { sizePt } : {}),
    ...(color !== undefined ? { color } : {}),
  }
}

/** Spacing (twentieths of a point) and a bottom border, from a paragraph's properties. */
function mergeBlock(base: BlockFormat, pPr: Element | null): BlockFormat {
  // Only the block properties: callers spread this over a full format.
  const next: BlockFormat = {}
  if (base.borderBottom !== undefined) next.borderBottom = base.borderBottom
  if (base.spaceBeforePt !== undefined) next.spaceBeforePt = base.spaceBeforePt
  if (base.spaceAfterPt !== undefined) next.spaceAfterPt = base.spaceAfterPt
  const spacing = wChild(pPr, 'spacing')
  const twips = (name: string) => {
    const value = spacing?.getAttributeNS(W, name) ?? spacing?.getAttribute(`w:${name}`)
    const n = value ? Number(value) : NaN
    return Number.isFinite(n) ? n / 20 : undefined
  }
  const before = twips('before')
  const after = twips('after')
  if (before !== undefined) next.spaceBeforePt = before
  if (after !== undefined) next.spaceAfterPt = after
  const bottom = wChild(wChild(pPr, 'pBdr'), 'bottom')
  if (bottom) next.borderBottom = !['nil', 'none'].includes(wVal(bottom) ?? '')
  return next
}

function alignOf(pPr: Element | null): ResumeParagraph['align'] | undefined {
  const val = wVal(wChild(pPr, 'jc'))
  if (!val) return undefined
  if (val === 'center') return 'center'
  if (val === 'right' || val === 'end') return 'right'
  return 'left'
}

class StyleSheet {
  private readonly byId = new Map<string, Element>()
  private readonly cache = new Map<string, ParagraphFormat>()
  private readonly defaults: RunFormat
  private readonly defaultParagraphStyle: string | null = null

  constructor(doc: Document | null) {
    if (!doc) {
      this.defaults = {}
      return
    }
    for (const style of Array.from(doc.getElementsByTagNameNS(W, 'style'))) {
      const id = style.getAttributeNS(W, 'styleId') ?? style.getAttribute('w:styleId')
      if (!id) continue
      this.byId.set(id, style)
      const isDefault = ['1', 'true'].includes(style.getAttributeNS(W, 'default') ?? style.getAttribute('w:default') ?? '')
      const type = style.getAttributeNS(W, 'type') ?? style.getAttribute('w:type')
      if (isDefault && type === 'paragraph') this.defaultParagraphStyle = id
    }
    const rPrDefault = doc.getElementsByTagNameNS(W, 'rPrDefault')[0]
    this.defaults = mergeRun({}, wChild(rPrDefault ?? null, 'rPr'))
  }

  /** Effective paragraph formatting for a style id (or the default paragraph style). */
  paragraph(styleId: string | null): ParagraphFormat {
    const id = styleId ?? this.defaultParagraphStyle ?? ''
    const cached = this.cache.get(id)
    if (cached) return cached

    const chain: Element[] = []
    const seen = new Set<string>()
    let current = this.byId.get(id)
    while (current && chain.length < 12) {
      chain.unshift(current)
      const next = wVal(wChild(current, 'basedOn'))
      if (!next || seen.has(next)) break
      seen.add(next)
      current = this.byId.get(next)
    }

    let format: ParagraphFormat = { ...this.defaults, name: '', numbered: false, outline: false }
    for (const style of chain) {
      const pPr = wChild(style, 'pPr')
      format = {
        ...format,
        ...mergeRun(format, wChild(style, 'rPr')),
        ...mergeBlock(format, pPr),
        name: (wVal(wChild(style, 'name')) ?? '').toLowerCase(),
        ...(alignOf(pPr) ? { align: alignOf(pPr) } : {}),
        numbered: format.numbered || Boolean(wChild(pPr, 'numPr')),
        outline: format.outline || Boolean(wChild(pPr, 'outlineLvl')),
      }
    }
    this.cache.set(id, format)
    return format
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Every paragraph with text, in document order, with effective formatting. */
export function readDocxParagraphs(bytes: Uint8Array): ResumeParagraph[] {
  const { paragraphs, styles } = parseDocx(bytes)
  const result: ResumeParagraph[] = []

  paragraphs.forEach((p, id) => {
    const runs = textRuns(p)
    const text = runs.map(runText).join('')
    if (!text.trim()) return

    const pPr = wChild(p, 'pPr')
    const style = styles.paragraph(wVal(wChild(pPr, 'pStyle')))
    const block = mergeBlock(style, pPr)
    const runFormats = runs.map((run) => mergeRun(style, wChild(run, 'rPr')))

    // Adjacent runs with the same look are one span.
    const spans: TextSpan[] = []
    runs.forEach((run, index) => {
      const piece = runText(run)
      if (!piece) return
      const span = spanOf(piece, runFormats[index]!)
      const last = spans[spans.length - 1]
      // A line break or space has no look of its own: it joins the text before it.
      if (last && (sameLook(last, span) || !piece.trim())) last.text += piece
      else spans.push(span)
    })

    const visible = runFormats.filter((_, index) => runText(runs[index]!).trim())
    const first = visible[0] ?? style
    const allBold = visible.every((f) => f.bold)

    result.push({
      id,
      text,
      role: roleOf(style, pPr),
      bold: allBold,
      align: alignOf(pPr) ?? style.align ?? 'left',
      ...(first.sizePt ? { sizePt: first.sizePt } : {}),
      ...(first.caps ? { caps: true } : {}),
      ...(first.italic ? { italic: true } : {}),
      ...(first.color ? { color: first.color } : {}),
      ...(spans.length > 1 ? { spans } : {}),
      ...(block.borderBottom ? { borderBottom: true } : {}),
      ...(block.spaceBeforePt !== undefined ? { spaceBeforePt: block.spaceBeforePt } : {}),
      ...(block.spaceAfterPt !== undefined ? { spaceAfterPt: block.spaceAfterPt } : {}),
    })
  })

  return result
}

function spanOf(text: string, format: RunFormat): TextSpan {
  return {
    text,
    bold: Boolean(format.bold),
    ...(format.italic ? { italic: true } : {}),
    ...(format.sizePt ? { sizePt: format.sizePt } : {}),
    ...(format.color ? { color: format.color } : {}),
    ...(format.caps ? { caps: true } : {}),
  }
}

export function sameLook(a: TextSpan, b: TextSpan): boolean {
  return (
    a.bold === b.bold &&
    Boolean(a.italic) === Boolean(b.italic) &&
    a.sizePt === b.sizePt &&
    (a.color ?? '') === (b.color ?? '') &&
    Boolean(a.caps) === Boolean(b.caps)
  )
}

function roleOf(style: ParagraphFormat, pPr: Element | null): ParagraphRole {
  if (/^title\b/.test(style.name)) return 'title'
  if (/^subtitle\b/.test(style.name)) return 'subtitle'
  if (/^heading\b/.test(style.name) || style.outline || wChild(pPr, 'outlineLvl')) return 'heading'
  if (wChild(pPr, 'numPr') || style.numbered) return 'bullet'
  return 'body'
}

/** The paragraph's own runs - not those of a text box nested inside it. */
function ownRuns(p: Element): Element[] {
  return Array.from(p.getElementsByTagNameNS(W, 'r')).filter((run) => closestParagraph(run) === p)
}

function textRuns(p: Element): Element[] {
  return ownRuns(p).filter((run) =>
    Array.from(run.children).some((child) => child.namespaceURI === W && TEXT_NODES.has(child.localName)),
  )
}

function closestParagraph(node: Element): Element | null {
  let current = node.parentElement
  while (current) {
    if (current.namespaceURI === W && current.localName === 'p') return current
    current = current.parentElement
  }
  return null
}

function runText(run: Element): string {
  let text = ''
  for (const child of Array.from(run.children)) {
    if (child.namespaceURI !== W) continue
    switch (child.localName) {
      case 't':
        text += child.textContent ?? ''
        break
      case 'tab':
        text += '\t'
        break
      case 'br':
      case 'cr':
        text += '\n'
        break
      case 'noBreakHyphen':
        text += '-'
        break
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Applies paragraph edits to the master .docx and returns the new file.
 * Throws if an edit targets a paragraph that does not exist or holds no text.
 */
export function applyDocxEdits(bytes: Uint8Array, edits: readonly ParagraphEdit[]): Uint8Array {
  const parsed = parseDocx(bytes)
  const { paragraphs, doc } = parsed
  const existing = (id: number) => {
    const p = paragraphs[id]
    if (!p || !textRuns(p).length) {
      throw new Error(`Paragraph ${id} does not exist in the master resume. Regenerate the tailored resume.`)
    }
    return p
  }

  // Resolve every target before mutating, so removals cannot shift the ids.
  const targets = edits.filter((edit) => !edit.insert).map((edit) => ({ edit, p: existing(edit.id) }))
  const inserts = edits
    .filter((edit) => edit.insert)
    .map((edit) => ({ edit, after: existing(edit.insert!.after), like: existing(edit.insert!.like) }))

  // Inserts first: they copy their template's original formatting, and their anchor
  // must still be in the document.
  const lastPlaced = new Map<Element, Element>()
  for (const { edit, after, like } of inserts) {
    const copy = copyParagraph(like)
    replaceParagraphText(doc, copy, edit.text, edit.fresh)
    const previous = lastPlaced.get(after) ?? after
    previous.parentNode!.insertBefore(copy, previous.nextSibling)
    lastPlaced.set(after, copy)
  }

  for (const { edit, p } of targets) {
    if (edit.removed) removeParagraph(p)
    else replaceParagraphText(doc, p, edit.text, edit.fresh)
  }

  const xml = new XMLSerializer().serializeToString(doc)
  const withDeclaration = xml.startsWith('<?xml') ? xml : `${parsed.declaration}${xml}`

  // Same entries, same order - only document.xml differs.
  const files: Record<string, Uint8Array> = {}
  for (const [name, data] of Object.entries(parsed.files)) {
    files[name] = name === DOCUMENT_PART ? strToU8(withDeclaration) : data
  }
  return zipSync(files)
}

function replaceParagraphText(doc: Document, p: Element, text: string, fresh = false): void {
  const runs = textRuns(p)
  const segments = runs.map(runText)
  let rest = text

  // Keep leading runs whose text survives unchanged ("Skills: " in bold).
  let first = 0
  while (first < runs.length - 1 && segments[first] && rest.startsWith(segments[first]!) && (!fresh || keepsLead(segments[first]!, rest))) {
    rest = rest.slice(segments[first]!.length)
    first += 1
  }

  // Same for trailing runs (a right-aligned date after a tab).
  let last = runs.length - 1
  while (last > first && segments[last] && rest.endsWith(segments[last]!) && (!fresh || keepsTrail(segments[last]!, rest))) {
    rest = rest.slice(0, rest.length - segments[last]!.length)
    last -= 1
  }

  const middle = runs.slice(first, last + 1)
  writeMiddle(doc, middle, rest, fresh)
}

/** Writes `text` over the given runs, each piece in the format `planMiddle` picks. */
function writeMiddle(doc: Document, runs: Element[], text: string, fresh: boolean): void {
  const format = (run: Element) => {
    const rPr = wChild(run, 'rPr')
    return rPr ? new XMLSerializer().serializeToString(rPr) : ''
  }
  const items = runs.map((run) => ({ text: runText(run), key: format(run), bold: toggle(wChild(run, 'rPr'), 'b') === true }))
  const pieces = planMiddle(items, text, fresh)

  // New runs go where the first old run was; the old ones are then retired.
  const anchor = runs[0]!
  for (const piece of pieces) {
    if (!piece.text) continue
    const clone = runs[piece.item]!.cloneNode(true) as Element
    setRunText(doc, clone, piece.text)
    anchor.parentNode!.insertBefore(clone, anchor)
  }
  for (const run of runs) retireRun(doc, run)
}

/**
 * Which of the old pieces' looks each part of the new text takes (shared by the
 * .docx writer and the PDF, so both look the same).
 *
 * A rewrite of the same sentence: the predominant look (most characters) is the
 * base, and every other piece's text is a "formatted phrase" that gets its look
 * back wherever it still occurs - so a rewritten bullet keeps **React** bold.
 *
 * Fresh text (written from scratch): the plain look throughout - bold is emphasis,
 * so a mixed paragraph's non-bold look wins - except a bold lead the old text had
 * ("Frontend:" label, a job title before " | "), which the new lead keeps.
 */
export function planMiddle(
  items: readonly { text: string; key: string; bold: boolean }[],
  text: string,
  fresh = false,
): { text: string; item: number }[] {
  const majority = (indices: readonly number[]) => {
    const weight = new Map<string, number>()
    for (const i of indices) weight.set(items[i]!.key, (weight.get(items[i]!.key) ?? 0) + items[i]!.text.length)
    const key = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    return Math.max(0, items.findIndex((item, i) => indices.includes(i) && item.key === key))
  }
  const all = items.map((_, i) => i)

  if (!fresh) {
    const base = majority(all)
    // Distinct formatted phrases, longest first so "Node.js" wins over "Node".
    const phrases = new Map<string, number>()
    items.forEach((item, i) => {
      const phrase = item.text.trim()
      if (item.key !== items[base]!.key && phrase.length >= 2 && !phrases.has(phrase)) phrases.set(phrase, i)
    })
    const ordered = [...phrases.keys()].sort((a, b) => b.length - a.length)
    return splitByPhrases(text, ordered).map((piece) => ({ text: piece.text, item: piece.phrase ? phrases.get(piece.phrase)! : base }))
  }

  // Which old pieces cover the lead, and which the rest.
  const original = items.map((item) => item.text).join('')
  const lead = leadOf(original)
  const leadItems: number[] = []
  const restItems: number[] = []
  let at = 0
  items.forEach((item, i) => {
    const start = at
    at += item.text.length
    if (!item.text.trim()) return
    if (lead && start < lead.end) leadItems.push(i)
    if (!lead || at > lead.end) restItems.push(i)
  })
  const plainOf = (indices: readonly number[]) => {
    const plain = indices.filter((i) => !items[i]!.bold)
    return majority(plain.length ? plain : indices.length ? indices : all)
  }

  const leadKeys = new Set(leadItems.map((i) => items[i]!.key))
  const leadStandsOut = lead && leadKeys.size === 1 && leadItems.length > 0 && restItems.some((i) => !leadKeys.has(items[i]!.key))
  if (leadStandsOut) {
    const base = plainOf(restItems)
    const newLead = leadOf(text, lead.kind)
    if (newLead) return [{ text: text.slice(0, newLead.end), item: leadItems[0]! }, { text: text.slice(newLead.end), item: base }]
    return [{ text, item: base }]
  }
  return [{ text, item: plainOf(all) }]
}

/**
 * Fresh text: an unchanged piece at the start (`kept`, `text` still including it)
 * keeps its own look only when it ends at a break - the name before a line break,
 * a job title before " | ", a "Label:" - not when the new sentence merely starts
 * like the old one ("Engineer with 10+ years building **React**...").
 */
export function keepsLead(kept: string, text: string): boolean {
  const after = text.slice(kept.length)
  return /[\t\n:|–—]\s*$/.test(kept) || /^\s*(?:[\t\n|–—]|$)/.test(after)
}

/** The same for an unchanged piece at the end (a date after a tab). */
export function keepsTrail(kept: string, text: string): boolean {
  const before = text.slice(0, text.length - kept.length)
  return /^\s*[\t\n|–—]/.test(kept) || /(?:[\t\n|–—:]\s*|^)$/.test(before)
}

/** The lead of a line: a "Label:" (colon included), or the part before " | " / " – ". */
function leadOf(text: string, kind?: 'label' | 'part'): { end: number; kind: 'label' | 'part' } | null {
  const label = /^[^:|\n\t]{1,60}:/.exec(text)
  const part = /\s+(?:\||–|—)\s+/.exec(text)
  const found: { end: number; kind: 'label' | 'part' }[] = []
  if (label && (!kind || kind === 'label')) found.push({ end: label[0].length, kind: 'label' })
  if (part && part.index > 0 && (!kind || kind === 'part')) found.push({ end: part.index, kind: 'part' })
  return found.sort((a, b) => a.end - b.end)[0] ?? null
}

/** Splits text around whole-word occurrences of the given phrases (longest match wins). */
export function splitByPhrases(text: string, phrases: string[]): { text: string; phrase?: string }[] {
  if (!phrases.length || !text) return [{ text }]
  const pieces: { text: string; phrase?: string }[] = []
  let cursor = 0
  while (cursor < text.length) {
    let best: { index: number; phrase: string } | null = null
    for (const phrase of phrases) {
      const index = indexOfWord(text, phrase, cursor)
      if (index !== -1 && (!best || index < best.index || (index === best.index && phrase.length > best.phrase.length))) {
        best = { index, phrase }
      }
    }
    if (!best) {
      pieces.push({ text: text.slice(cursor) })
      break
    }
    if (best.index > cursor) pieces.push({ text: text.slice(cursor, best.index) })
    pieces.push({ text: best.phrase, phrase: best.phrase })
    cursor = best.index + best.phrase.length
  }
  return pieces
}

/** Occurrence of `phrase` not glued to surrounding letters/digits ("Go" not in "Google"). */
function indexOfWord(text: string, phrase: string, from: number): number {
  let index = text.indexOf(phrase, from)
  while (index !== -1) {
    const before = text[index - 1] ?? ' '
    const after = text[index + phrase.length] ?? ' '
    if (!/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) return index
    index = text.indexOf(phrase, index + 1)
  }
  return -1
}

/** Removes a run that only held text; one that also holds a drawing or field code is just emptied. */
function retireRun(doc: Document, run: Element): void {
  const onlyText = Array.from(run.children).every(
    (child) => child.namespaceURI === W && (child.localName === 'rPr' || TEXT_NODES.has(child.localName)),
  )
  if (onlyText) run.parentNode?.removeChild(run)
  else setRunText(doc, run, '')
}

function setRunText(doc: Document, run: Element, text: string): void {
  for (const child of Array.from(run.children)) {
    if (child.namespaceURI === W && TEXT_NODES.has(child.localName)) run.removeChild(child)
  }

  for (const piece of text.split(/(\t|\n)/)) {
    if (!piece) continue
    if (piece === '\t') {
      run.appendChild(doc.createElementNS(W, 'w:tab'))
    } else if (piece === '\n') {
      run.appendChild(doc.createElementNS(W, 'w:br'))
    } else {
      const t = doc.createElementNS(W, 'w:t')
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve')
      t.textContent = piece
      run.appendChild(t)
    }
  }
}

/**
 * A copy of a paragraph to hold new text: same style, numbering and run formats.
 * Things that must be unique or only appear once are left out - section breaks,
 * bookmarks, comment anchors and Word's paragraph ids.
 */
function copyParagraph(p: Element): Element {
  const copy = p.cloneNode(true) as Element
  const pPr = wChild(copy, 'pPr')
  const sectPr = wChild(pPr, 'sectPr')
  if (sectPr) pPr!.removeChild(sectPr)
  for (const name of ['bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd', 'commentReference']) {
    for (const element of Array.from(copy.getElementsByTagNameNS(W, name))) element.parentNode?.removeChild(element)
  }
  for (const attribute of Array.from(copy.attributes)) {
    if (/^w14:(paraId|textId)$/.test(attribute.name)) copy.removeAttribute(attribute.name)
  }
  return copy
}

/**
 * Deletes a paragraph - unless Word requires it to exist (the only paragraph of a
 * table cell, or one carrying the section properties), in which case it is emptied.
 */
function removeParagraph(p: Element): void {
  const parent = p.parentElement
  const holdsSection = Boolean(wChild(wChild(p, 'pPr'), 'sectPr'))
  const onlyInCell =
    parent?.localName === 'tc' &&
    Array.from(parent.children).filter((child) => child.localName === 'p').length <= 1

  if (!parent || holdsSection || onlyInCell) {
    for (const run of textRuns(p)) setRunText(p.ownerDocument, run, '')
    return
  }
  parent.removeChild(p)
}

// ---------------------------------------------------------------------------
// Plain-text masters
// ---------------------------------------------------------------------------

/** Paragraphs for a master that only exists as text (.txt/.md/pasted). No layout to preserve. */
export function paragraphsFromText(text: string): ResumeParagraph[] {
  const result: ResumeParagraph[] = []
  text.split(/\r?\n/).forEach((line, id) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const bullet = /^[-*•▪–]\s+/.test(trimmed)
    const heading = !bullet && trimmed.length <= 40 && /^[A-Z0-9 &/,.'()-]+$/.test(trimmed) && /[A-Z]/.test(trimmed)
    result.push({
      id,
      text: bullet ? trimmed.replace(/^[-*•▪–]\s+/, '') : trimmed,
      role: bullet ? 'bullet' : heading ? 'heading' : 'body',
      bold: heading,
      align: 'left',
    })
  })
  return result
}

export function paragraphsToText(paragraphs: readonly ResumeParagraph[]): string {
  return paragraphs.map((p) => (p.role === 'bullet' ? `- ${p.text}` : p.text)).join('\n')
}
