/**
 * Application-side types: detected form fields, saved answers, and the persistent
 * session that survives a browser restart.
 *
 * Phase 1/2 only reads and renders these. The scanner (phase 3) and multi-page
 * engine (phase 4) populate them, which is why they are defined up front - the
 * side panel UI and the storage schema are already shaped for it.
 */

import type { PendingAITask } from './ai'
import type { CoverLetterState, DraftedAnswer, TailoredResumeState } from './resume'

/**
 * Question categories - spec section 9. The category decides *who* is allowed to
 * produce an answer, so this drives real behaviour rather than being a label.
 */
export type QuestionCategory =
  /** Safe reusable profile information (name, email, phone, work authorization...). */
  | 'GLOBAL'
  /** Depends on the specific job (salary, start date, relocation...). */
  | 'JOB_DEPENDENT'
  /** Free-text answers the AI may draft from resume + JD, always user-reviewable. */
  | 'AI_GENERATED'
  /** Legal attestations, signatures, EEO/demographics. Never auto-answered. Ever. */
  | 'USER_CONFIRMATION_REQUIRED'

export type FieldInputType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'unknown'

export type WidgetKind = 'buttons' | 'radiogroup' | 'listbox' | 'typeahead'

/** A normalised form field, independent of the site it came from (spec section 15). */
export interface ApplicationField {
  /** Stable-ish id within a page scan; used to re-locate the element. */
  id: string
  /** Best human-readable label we could find (label > aria-label > placeholder > nearby text). */
  label: string
  type: FieldInputType
  required: boolean
  value?: string
  /** Options for select/radio/checkbox groups. */
  options?: string[]
  /** Character limit the page enforces, when it states one. Passed to drafted answers. */
  maxLength?: number
  /** File inputs: the `accept` attribute, used to choose .docx or .pdf. */
  accept?: string
  /**
   * A site-built widget (div dropdown, custom radio group, rich text box) rather
   * than a native control. It is listed and its value read, but never filled -
   * writing into a widget the extension does not understand is how wrong answers
   * get submitted.
   */
  custom?: boolean
  /**
   * How a site-built control is operated, when the extension knows how:
   *  - buttons:    a row of option buttons (Ashby's Yes / No)
   *  - radiogroup: ARIA radio options (role="radio")
   *  - listbox:    a dropdown trigger that opens a list of options
   *  - typeahead:  a text box that suggests options as you type ("Start typing...")
   * A widget with a kind is filled like a person would - by clicking the matching
   * option - and verified; one without a kind is only listed.
   */
  widget?: WidgetKind
  /**
   * A question marked required (*) whose control could not be read at all. Its
   * value is unknown, so it is shown as "check on the page" and never blocks Next.
   */
  valueUnknown?: boolean
  /** Which profile/answer key we think this maps to. */
  canonicalField?: string
  category?: QuestionCategory
  /** 0-1 classification confidence. Below the fill threshold we ask instead of guessing. */
  confidence?: number
  /** Why this field is unresolved, shown to the user verbatim. */
  unresolvedReason?: string
}

export interface ValidationError {
  fieldId?: string
  message: string
}

export type NextControlKind = 'next' | 'submit'

/**
 * What a page *is*, independent of what has been typed into it (spec section 17).
 *
 * Field values are deliberately excluded: filling a page must never look like
 * navigating away from it. Identity comes from the URL, the step heading and the
 * set of questions asked.
 */
export interface PageFingerprint {
  /** origin + path + hash. Query strings are dropped - they churn on tracking params. */
  url: string
  /** Step heading or active step indicator text, if the page has one. */
  heading: string
  /** One `type:label` entry per field, sorted. A multiset - duplicates are kept. */
  fieldKeys: string[]
  takenAt: number
}

/**
 * How two fingerprints relate.
 *  - same:     nothing structural changed.
 *  - modified: same page, but questions appeared/disappeared (conditional fields).
 *  - new-page: a different step of the application.
 */
export type PageChange = 'same' | 'modified' | 'new-page'

/** Result of scanning one application page. */
export interface ScanResult {
  url: string
  /** Which adapter handled the scan, e.g. "generic" or "greenhouse". */
  adapter: string
  fields: ApplicationField[]
  /** Text of the detected Next/Continue/Submit control, if any. */
  nextButtonLabel: string | null
  nextButtonKind: NextControlKind | null
  page: PageFingerprint
  /** Application forms embedded from another site (iframe src), which this page scan cannot read. */
  embeddedForms: string[]
  /** The page reads like a "thank you, application received" screen. Only a hint. */
  confirmationDetected: boolean
  scannedAt: number
}

/** An instruction to write one value into one field. */
export interface FillInstruction {
  fieldId: string
  value: string
  /** Where the value came from, shown to the user so a fill is never unexplained. */
  source: 'profile' | 'saved-answer' | 'user'
  canonicalField?: string
  /** Set for site-built controls: how to operate it (click an option, type and pick...). */
  widget?: WidgetKind
}

export interface FillOutcome {
  fieldId: string
  filled: boolean
  /** The value actually present in the DOM after the write, for verification. */
  actualValue?: string
  error?: string
}

/** Why a field was not filled automatically. */
export type SkipReasonCode =
  | 'ALREADY_FILLED'
  | 'NO_VALUE'
  | 'LOW_CONFIDENCE'
  | 'NEEDS_USER'
  | 'AI_REQUIRED'
  | 'FILE_UPLOAD'
  | 'UNMAPPED'

export interface FieldPlan {
  field: ApplicationField
  decision: 'fill' | 'ask' | 'skip'
  value?: string
  source?: FillInstruction['source']
  reasonCode?: SkipReasonCode
  reason?: string
}

export interface AutofillReport {
  scannedAt: number
  url: string
  adapter: string
  totalFields: number
  requiredFields: number
  /** Fields that hold a value right now, however they came to hold it. */
  completedFields: number
  /** Required fields still empty - the number that actually blocks submission. */
  outstandingRequired: number
  /** Fields this pass wrote to. */
  filled: FillOutcome[]
  /** Fields the user must answer before the page can be completed. */
  ask: FieldPlan[]
  /** Fields intentionally left alone, with the reason. */
  skipped: FieldPlan[]
  validationErrors: ValidationError[]
  nextButtonLabel: string | null
  nextButtonKind: NextControlKind | null
  /** Every field on the page as it stands after this pass - the full checklist. */
  fields?: ApplicationField[]
  embeddedForms?: string[]
}

/** One page of a multi-page application, as the session remembers it. */
export interface StepRecord {
  /** 1-based. */
  step: number
  page: PageFingerprint
  firstSeenAt: number
  lastSeenAt: number
  /** Fields on the page / fields holding a value, at the last scan of this step. */
  totalFields: number
  completedFields: number
}

/**
 * What happened when Next was requested (spec section 18). Clicking is never
 * treated as success - only an observed page change is.
 */
export type NavigationOutcome =
  /** The page changed to a step we had not seen. */
  | 'ADVANCED'
  /** The page changed to a step seen earlier (a Back, or the site bounced us). */
  | 'RETURNED'
  /** Not clicked: required fields are still empty. */
  | 'BLOCKED'
  /** Clicked, the page stayed, and it is showing errors. */
  | 'VALIDATION_FAILED'
  /** Clicked, and nothing observable happened before the timeout. */
  | 'NO_CHANGE'
  /** No Next/Continue control could be found. */
  | 'NO_CONTROL'
  /** The only control is a final submit, which is always left to the user. */
  | 'SUBMIT_REFUSED'
  /** The user pressed Cancel while it was running. */
  | 'CANCELLED'

export interface NavigationResult {
  outcome: NavigationOutcome
  /** One sentence for the panel. */
  message: string
  at: number
  fromStep: number
  toStep: number
  /** Label of the control that was (or would have been) clicked. */
  controlLabel?: string
  errors: ValidationError[]
  /** Required fields that stopped a BLOCKED navigation. */
  blockingFields?: ApplicationField[]
  /** Fields filled by the automatic correct-and-retry pass. */
  autoCorrected?: number
}

/** A reusable answer the user chose to save (spec section 7). */
export interface SavedAnswer {
  /** Canonical field key, e.g. "noticePeriod". */
  key: string
  /** Label shown in Settings; usually the question text it was first saved from. */
  label: string
  value: string
  /** When false the answer is remembered but never filled without asking. */
  autoFill: boolean
  category: QuestionCategory
  updatedAt: number
}

export type SessionStatus =
  | 'ANALYZING'
  | 'RESUME_REVIEW'
  | 'APPLYING'
  | 'NEEDS_INPUT'
  | 'REVIEW'
  | 'SUBMITTED'

/** Persistent per-job application state (spec section 19). */
export interface ApplicationSession {
  id: string
  /** Sheet coordinates for write-back. */
  sheetRow: number
  spreadsheetId: string
  sheetName: string

  jobUrl: string
  company: string
  position: string

  /** Job info extracted from the page, once available. */
  jobInfo?: JobInfoRef

  /** Filename of the tailored resume once saved - written to the Resume column on Done. */
  tailoredResume?: string
  resumeApproved?: boolean

  /** Phase 5: tailored resume edits under review, cover letter, drafted answers. */
  resume?: TailoredResumeState
  coverLetter?: CoverLetterState
  /** Drafted written answers, by field id. */
  answers?: Record<string, DraftedAnswer>
  /** Prompts handed to the user and awaiting a pasted reply, by task key. */
  pendingAi?: Record<string, PendingAITask>
  /** What autopilot has done for this application, so it never repeats a step. */
  autopilot?: AutopilotState

  /** 1-based page/step index within a multi-page application. */
  currentStep: number
  totalStepsSeen: number

  completedFields: Record<string, unknown>
  unansweredFields: ApplicationField[]

  /** Most recent scan/autofill result for the page the user is on. */
  lastReport?: AutofillReport

  /** Fingerprint of the application page the session is currently on (phase 4). */
  currentPage?: PageFingerprint
  /** Every application page seen, in step order. Absent on sessions from before phase 4. */
  steps?: StepRecord[]
  /** Outcome of the most recent Next request. */
  lastNavigation?: NavigationResult
  /** Last application page URL, so a closed tab (or restarted browser) can be reopened there. */
  lastPageUrl?: string
  /** The page looks like a submission confirmation. Prompts the user to press Done; never acts. */
  confirmationDetected?: boolean

  status: SessionStatus

  /** Tab we opened for this job, so the panel can re-focus it. */
  tabId?: number

  createdAt: number
  updatedAt: number
}

/**
 * - running: in progress now
 * - done:    finished and saved without needing the user
 * - stopped: produced, but held for the user (fact-check warnings, unreliable input)
 * - failed:  could not run (API error...); the manual buttons still work
 */
export type AutopilotStepState = 'running' | 'done' | 'stopped' | 'failed'

export interface AutopilotStep {
  state: AutopilotStepState
  note?: string
  at: number
}

export interface AutopilotState {
  resume?: AutopilotStep
  coverLetter?: AutopilotStep
  /** Upload attempts by `fieldId@pageUrl`, so a field is tried once per page. */
  attached?: Record<string, { fileName: string; ok: boolean; at: number; note?: string }>
}

/** Kept structurally separate so `application.ts` does not import `job.ts` circularly. */
export interface JobInfoRef {
  /** Page the posting was read from. Absent on sessions extracted before this was recorded. */
  url?: string
  title: string
  company: string
  location: string
  description: string
  source: string
  confidence: number
  extractedAt: number
}
