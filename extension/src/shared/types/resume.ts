/**
 * Resume tailoring and cover letter types (spec sections 10-14 + cover letter addendum).
 *
 * Tailoring is expressed as *edits to the master resume's paragraphs*, never as a
 * new document. That is what lets the .docx keep its exact layout: the generator
 * replaces text inside existing paragraphs and touches nothing else.
 */

import type { GeneratedBy } from './ai'

export type ParagraphRole ='title' | 'subtitle' | 'heading' | 'bullet' | 'body'

/** A stretch of text with one format - what the PDF needs to look like the .docx. */
export interface TextSpan {
  text: string
  bold: boolean
  italic?: boolean
  /** Font size in points, when the document sets one. */
  sizePt?: number
  /** Text colour as "RRGGBB", when not the default. */
  color?: string
  /** Shown in capitals (Word's "All caps"). */
  caps?: boolean
}

/** One paragraph of the master resume, in document order. */
export interface ResumeParagraph {
  /** Index among all paragraphs of the document body - the address an edit targets. */
  id: number
  /** Plain text. Tabs are `\t`, line breaks inside the paragraph are `\n`. */
  text: string
  role: ParagraphRole
  /** Every text run is bold (after resolving styles). */
  bold: boolean
  align: 'left' | 'center' | 'right'
  /** Effective font size of the first run, after resolving styles. */
  sizePt?: number
  /** Rendered in capitals (Word's "All caps"), whatever the stored text's case. */
  caps?: boolean
  italic?: boolean
  /** Text colour of the first run, "RRGGBB". */
  color?: string
  /** Spans, when the paragraph mixes formats (bold keywords, a name and an italic title on two lines). */
  spans?: TextSpan[]
  /** A line drawn under the paragraph (a section heading's rule). */
  borderBottom?: boolean
  /** Space before / after the paragraph, in points. */
  spaceBeforePt?: number
  spaceAfterPt?: number
}

export interface ParagraphEdit {
  /** The master paragraph edited - or, for an insert, a new id no master paragraph has. */
  id: number
  /** Master text at the time of tailoring, so review can show before/after. Empty for an insert. */
  original: string
  text: string
  /** The paragraph is deleted from the output (e.g. an irrelevant bullet). */
  removed?: boolean
  /**
   * A new paragraph: placed after master paragraph `after` (several after the same
   * one keep their order), formatted as a copy of master paragraph `like` - so an
   * added bullet is a real bullet of that list, with its numbering and indent.
   */
  insert?: { after: number; like: number }
  /**
   * New text written from scratch (the chat's JSON), not a rewrite of this
   * paragraph's sentence: it takes the paragraph's plain look, and only a bold
   * "Label:" or job title at its start stays bold - bold words of the old text are
   * not scattered over the new one.
   */
  fresh?: boolean
}

/** First id given to inserted paragraphs; master paragraph ids are far below it. */
export const INSERT_ID_BASE = 100_000

/** Something in generated text that the master resume does not support. Never blocking; always shown. */
export interface FactWarning {
  paragraphId?: number
  message: string
}

export interface TailoredResumeState {
  /** Model that wrote it (absent for copy/paste replies). */
  generatedBy?: GeneratedBy
  /**
   * gpt-file: ChatGPT created the PDF itself; `edits` is empty and the file's bytes
   * are kept in storage (sidepanel/lib/gpt-resume.ts). Absent: edits to the master.
   */
  source?: 'gpt-file'
  promptProfileId: string
  promptProfileName: string
  /** One-off instructions for this job ("Edit for this job"); never saved to the profile. */
  instructions?: string
  edits: ParagraphEdit[]
  changeNotes: string[]
  warnings: FactWarning[]
  /** Identifies the master the edits apply to; a replaced master invalidates them. */
  masterFileName: string
  masterUploadedAt: number
  generatedAt: number
  docxFileName?: string
  pdfFileName?: string
  approved: boolean
}

export interface CoverLetterState {
  generatedBy?: GeneratedBy
  /**
   * gpt-file: ChatGPT created the letter as a file; that file is what gets uploaded
   * (kept in storage), and `text` is read from it for text boxes. Editing the text
   * drops this, and the letter is then rendered from the text like any other.
   */
  source?: 'gpt-file'
  docxFileName?: string
  text: string
  instructions?: string
  warnings: FactWarning[]
  generatedAt: number
  pdfFileName?: string
  approved: boolean
}

export interface DraftedAnswer {
  generatedBy?: GeneratedBy
  /** Set when HumanGPT rewrote the draft: the AI's own draft, kept for "Use original". */
  originalText?: string
  humanized?: { mode: string; aiScore: number | null; resisted: boolean; wordsRemaining: number | null }
  /** Why the humanizer was skipped this time (quota, error, too short) - shown, never silent. */
  humanizerNote?: string
  fieldId: string
  question: string
  text: string
  warnings: FactWarning[]
  generatedAt: number
}
