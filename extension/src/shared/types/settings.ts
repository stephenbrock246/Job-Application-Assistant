/** Prompt profiles, resume metadata, and extension preferences. */

import type { AIProviderId } from './ai'
import type { JobSourceId } from './source'

/** What a prompt profile is for. Each kind has its own default (cover letter addendum). */
export type PromptKind = 'resume' | 'coverLetter'

/** Spec section 12 - multiple named prompts per kind. */
export interface PromptProfile {
  id: string
  /** Absent on profiles saved before cover letters existed; those are resume prompts. */
  kind?: PromptKind
  name: string
  prompt: string
  isDefault: boolean
  updatedAt: number
}

/** The uploaded master resume (spec section 10). */
export interface MasterResumeMeta {
  fileName: string
  mimeType: string
  sizeBytes: number
  uploadedAt: number
  /** Plain text of the resume - what the cover letter and answer prompts see. */
  text: string
  /** True when text extraction was partial/heuristic and may need review. */
  textIsApproximate: boolean
  /**
   * 'docx': the original file is kept and tailored in place, preserving its layout.
   * 'text': only text exists (txt/md/pasted, or a PDF whose text was pasted); output is PDF only.
   * Absent on masters saved before phase 5, which were always text.
   */
  format?: 'docx' | 'text'
  /** The original .docx, base64. Tailored resumes are this file with paragraph text replaced. */
  docxBase64?: string
}

export interface Preferences {
  /** Where the job queue is read from and written back to. */
  jobSourceId: JobSourceId
  /**
   * How the AI runs:
   * - chat: the user's own ChatGPT / Claude chats, on their login (no key);
   * - api:  an API key - Google Gemini (free tier) or OpenAI - chosen by `aiProviderId`.
   */
  aiMode: 'chat' | 'api'
  /** The API provider used when `aiMode` is "api". */
  aiProviderId: AIProviderId
  /** CSV only: write the file back automatically after each change, when possible. */
  autoSaveCsv: boolean
  /** Show every row from the sheet instead of only actionable ones. */
  showCompletedJobs: boolean
  /** Set Status to "In Progress" when a job is opened (spec section 22). */
  markInProgressOnOpen: boolean
  /** Open each job in a new tab rather than reusing the current one. */
  openJobsInNewTab: boolean
  /** Auto-refresh the queue when the side panel regains focus. */
  refreshOnFocus: boolean
  /** Run an autofill pass whenever a new application page is detected (spec section 17). */
  autofillOnNewPage: boolean

  /** OpenAI API model id. */
  openaiModel: string
  /** Gemini API model id. */
  geminiModel: string
  /**
   * Gemini model tried once when the primary keeps answering 503 (overloaded).
   * Empty string = no fallback.
   */
  geminiFallbackModel: string
  /** Replace email, phone and links with placeholders before sending to Gemini. */
  redactContacts: boolean
  /** A paragraph the user wrote themselves; drafts match its voice. Empty = plain-voice rules only. */
  writingSample: string

  /**
   * Who tailors the resume: the selected AI provider, or the user's ChatGPT
   * project (driven in their logged-in chatgpt.com tab). Answers and cover letters
   * always use the selected provider.
   */
  tailorVia: 'provider' | 'chatgpt-project'
  /** The ChatGPT chat (or project) link (holds the user's tailoring instructions and CV). */
  chatgptProjectUrl: string
  /**
   * What the ChatGPT chat returns:
   * - edits:    paragraph edits the extension applies to the master .docx;
   * - gpt-file: ChatGPT gets only the job description and creates the PDF itself;
   *             the extension saves and uploads that file.
   */
  chatgptOutput: 'edits' | 'gpt-file'
  /**
   * What the tailoring chat returns (replaces `chatgptOutput`):
   * - content: the CV's changing parts as text (headline, summary, skills, each
   *            position's title and bullets) and the cover letter; the extension
   *            builds both files from the master resume;
   * - file:    the chat creates the PDF files itself.
   */
  tailorOutput: 'content' | 'file'
  /** The one chat (ChatGPT or Claude) for written answers and cover letters. */
  chatgptAnswersUrl: string
  /** Line sent above the numbered questions; {company} and {position} are filled in. */
  chatgptAnswersMessage: string
  /** gpt-file: the line sent above the job description. Empty = the job description only. */
  chatgptMessage: string

  /** Rewrite drafted written answers with HumanGPT after the AI drafts them. Off by default. */
  humanizerEnabled: boolean
  /** HumanGPT strength. "light" changes the least, so meaning is most likely to survive. */
  humanizerMode: 'light' | 'medium' | 'heavy'

  // Autopilot. Generation steps only run with an automatic (API) provider.
  /** Tailor the resume as soon as the job description is extracted. */
  autoTailorResume: boolean
  /** Write a cover letter when the application has a cover letter field. */
  autoCoverLetter: boolean
  /** Approve and save generated text that passed the fact check with no warnings. */
  autoApproveClean: boolean
  /** Attach the approved resume / cover letter to the page's upload fields. */
  autoAttachFiles: boolean
}

export interface GoogleAccountInfo {
  email: string
  connectedAt: number
}
