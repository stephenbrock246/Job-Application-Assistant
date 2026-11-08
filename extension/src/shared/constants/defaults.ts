import type { ApplicantProfile } from '../types/profile'
import type { Preferences, PromptProfile } from '../types/settings'

export const STORAGE_KEYS = {
  profile: 'applicantProfile',
  answers: 'defaultAnswers',
  prompts: 'promptProfiles',
  preferences: 'preferences',
  sheetConfig: 'sheetConfig',
  sessions: 'sessions',
  activeSessionId: 'activeSessionId',
  masterResume: 'masterResume',
  googleAccount: 'googleAccount',
  queueCache: 'queueCache',
} as const

export const EMPTY_PROFILE: ApplicantProfile = {
  personal: {
    firstName: '',
    middleName: '',
    lastName: '',
    fullName: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    country: '',
    linkedin: '',
    github: '',
    portfolio: '',
  },
  professional: {
    currentTitle: '',
    currentCompany: '',
    yearsOfExperience: '',
    primarySkills: '',
    education: '',
  },
  preferences: {
    expectedSalary: '',
    salaryCurrency: 'USD',
    salaryPeriod: 'yearly',
    preferredLocation: '',
    remotePreference: '',
    relocationPreference: '',
    noticePeriod: '',
    availableStartDate: '',
  },
  workAuthorization: {
    workAuthorization: '',
    sponsorshipRequired: '',
  },
  voluntary: {
    gender: '',
    raceEthnicity: '',
    veteranStatus: '',
    disabilityStatus: '',
  },
  updatedAt: 0,
}

export const DEFAULT_PREFERENCES: Preferences = {
  jobSourceId: 'sheet-link',
  aiMode: 'chat',
  aiProviderId: 'gemini-api',
  autoSaveCsv: true,
  showCompletedJobs: false,
  markInProgressOnOpen: true,
  openJobsInNewTab: true,
  refreshOnFocus: true,
  autofillOnNewPage: true,
  openaiModel: 'gpt-6-sol',
  geminiModel: 'gemini-3.8-flash',
  // An older generation: separate capacity, so usually free when the newest is overloaded.
  geminiFallbackModel: 'gemini-2.5-flash',
  redactContacts: true,
  writingSample: '',
  tailorVia: 'provider',
  chatgptProjectUrl: '',
  // The user's chat already knows their tailoring prompt and CV: send the job only.
  chatgptOutput: 'gpt-file',
  // The chat writes text; the extension makes the files - far more reliable than chat-made PDFs.
  tailorOutput: 'content',
  chatgptAnswersUrl: '',
  chatgptAnswersMessage:
    'Answer these job application questions for the {position} role at {company}. Reply with each answer after its number in brackets, like [1] ... [2] ... - answers only, no headings.',
  chatgptMessage: 'Tailor CV and make downloadable CV, download it automatically.',
  humanizerEnabled: false,
  humanizerMode: 'light',
  autoTailorResume: true,
  autoCoverLetter: true,
  autoApproveClean: true,
  autoAttachFiles: true,
}

/** Spec section 11 - the default tailoring prompt, editable in Settings. */
export const DEFAULT_TAILORING_PROMPT = `Tailor my master resume for the supplied job description.

Rules:

1. Never fabricate experience.
2. Never fabricate employers.
3. Never fabricate employment dates.
4. Never fabricate education or certifications.
5. Preserve the factual meaning of my experience.
6. Emphasize experience relevant to the job.
7. Incorporate relevant ATS keywords naturally.
8. Improve the professional summary for this position.
9. Prioritize relevant skills.
10. Rewrite existing bullets where useful without inventing accomplishments.
11. Keep the resume professional and concise.
12. Preserve the overall resume structure unless changing it materially improves relevance.`

export function createDefaultPromptProfile(): PromptProfile {
  return {
    id: 'default',
    kind: 'resume',
    name: 'Software Engineer (Default)',
    prompt: DEFAULT_TAILORING_PROMPT,
    isDefault: true,
    updatedAt: Date.now(),
  }
}

/** Cover letter addendum - the default cover letter prompt, editable in Settings. */
export const DEFAULT_COVER_LETTER_PROMPT = `Write a concise cover letter for this job based strictly on my master resume and the supplied job description.

Write from the perspective of a senior software engineer.

Use natural, verbal-style professional English. It should sound like a real person explaining why their experience fits the opportunity rather than like an AI-generated corporate letter.

Focus on the strongest overlap between my actual experience and the position.

Do not fabricate technologies, experience, accomplishments, employers, dates, education, or certifications.

Do not simply summarize my entire resume.

Keep it direct and approximately 250-400 words unless the job application specifies another length.

Avoid generic phrases, excessive enthusiasm, buzzwords, and unnecessary formality.`

export function createDefaultCoverLetterProfile(): PromptProfile {
  return {
    id: 'default-cover-letter',
    kind: 'coverLetter',
    name: 'Cover letter (Default)',
    prompt: DEFAULT_COVER_LETTER_PROMPT,
    isDefault: true,
    updatedAt: Date.now(),
  }
}

/** Google API endpoints. */
export const GOOGLE = {
  sheetsApi: 'https://sheets.googleapis.com/v4/spreadsheets',
  userInfo: 'https://www.googleapis.com/oauth2/v3/userinfo',
  revoke: 'https://oauth2.googleapis.com/revoke',
} as const

/** How long a queue snapshot is considered fresh, in ms. */
export const QUEUE_CACHE_TTL = 60_000
