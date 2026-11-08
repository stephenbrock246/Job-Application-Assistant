/**
 * Stubbed `chrome` + sample data, then the real side panel entry.
 * Scenario from the URL: ?scenario=idle | session | settings
 */

import { STORAGE_KEYS } from '@/shared/constants/defaults'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'session'
const now = Date.now()

// --- storage ----------------------------------------------------------------
const store: Record<string, unknown> = {
  [STORAGE_KEYS.preferences]: {
    tailorVia: 'chatgpt-project',
    chatgptProjectUrl: 'https://chatgpt.com/g/g-p-6ad0bc5fe89c-job-application/project',
    tailorOutput: 'content',
  },
  [STORAGE_KEYS.masterResume]: {
    fileName: 'Agamyrat_Akmyradov_CV.docx',
    format: 'docx',
    text: 'AGAMYRAT AKMYRADOV\nSenior Software Engineer',
    docxBase64: 'UEsDBA==',
    uploadedAt: 1,
  },
  [STORAGE_KEYS.profile]: {
    personal: { fullName: 'Agamyrat Akmyradov', firstName: 'Agamyrat', lastName: 'Akmyradov', email: 'a@example.com', phone: '+40 791 392 970', city: 'Bucharest', country: 'Romania' },
  },
}
const changeListeners = new Set<(changes: Record<string, { newValue?: unknown }>, area: string) => void>()
const storageLocal = {
  async get(keys?: string | string[] | null) {
    if (keys == null) return { ...store }
    const list = Array.isArray(keys) ? keys : [keys]
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]))
  },
  async set(items: Record<string, unknown>) {
    Object.assign(store, items)
    const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]))
    changeListeners.forEach((fn) => fn(changes, 'local'))
  },
  async remove(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k]
  },
}

// --- sample data ------------------------------------------------------------
const jobs = [
  ['Liftoff', 'Senior Software Engineer, View Master', 'jobs.lever.co', 'READY'],
  ['Novalnet', 'Senior Full Stack Developer', 'boards.greenhouse.io', 'READY'],
  ['Andor Health', 'Staff Frontend Engineer', 'jobs.ashbyhq.com', 'IN_PROGRESS'],
  ['Makersite', 'Senior Frontend Engineer', 'makersite.io', 'READY'],
  ['Ayble Health', 'Senior Software Engineer', 'jobs.lever.co', 'READY'],
  ['Northwind', 'Lead Software Engineer', 'northwind.com', 'READY'],
  ['Gentoo', 'Frontend Engineer', 'gentoo.ro', 'READY'],
].map(([company, position, host, status], index) => ({
  rowNumber: index + 2,
  id: `sheet:Jobs:${index + 2}`,
  date: '2026-11-05',
  jobLink: `https://${host}/job/${index}`,
  company,
  position,
  statusRaw: status === 'READY' ? '' : 'In progress',
  status,
  other: '',
  appliedDate: '',
  resume: '',
}))

const description =
  "Liftoff's View Master team builds the creative tooling for mobile advertising. You will make architectural decisions for our web platform, keep interfaces responsive, and work with product and design. Requirements: 7+ years of JavaScript and TypeScript, React, HTML5 and CSS3; experience with performance work (code splitting, lazy loading, Web Workers); testing with Jest or Playwright; AWS. ".repeat(4)

const field = (id: string, label: string, type: string, value = '', required = true) => ({ id, label, type, required, value, category: 'GLOBAL', confidence: 0.95 })
const session = {
  id: 's1',
  sheetRow: 2,
  spreadsheetId: 'sheet',
  sheetName: 'Jobs',
  jobUrl: 'https://jobs.lever.co/liftoff/123',
  company: 'Liftoff',
  position: 'Senior Software Engineer, View Master',
  jobInfo: { url: 'https://jobs.lever.co/liftoff/123', title: 'Senior Software Engineer', company: 'Liftoff', location: 'Remote', description, source: 'lever', confidence: 0.92, extractedAt: now },
  resume: {
    promptProfileId: 'chat-content',
    promptProfileName: 'Your ChatGPT chat',
    generatedBy: { model: 'ChatGPT', fallback: false },
    edits: [
      { id: 3, original: 'Senior Software Engineer | Full Stack Developer', text: 'Senior Software Engineer | JavaScript, TypeScript, React, HTML5 & Cloud Architecture', fresh: true },
      { id: 7, original: 'Built React interfaces for patient workflows.', text: 'Built responsive application interfaces with React, TypeScript, JavaScript, HTML5, and CSS3.', fresh: true },
    ],
    changeNotes: [],
    warnings: [{ paragraphId: 7, message: '"Playwright" comes from the job description - check it is true for you.' }],
    masterFileName: 'Agamyrat_Akmyradov_CV.docx',
    masterUploadedAt: 1,
    generatedAt: now - 120_000,
    approved: true,
    docxFileName: 'Agamyrat_Akmyradov_CV.docx',
    pdfFileName: 'Agamyrat_Akmyradov_CV.pdf',
  },
  resumeApproved: true,
  coverLetter: { text: 'Dear Hiring Team,\n\nI build fast, reliable web interfaces.\n\nKind regards,\nAgamyrat Akmyradov', warnings: [], generatedAt: now, approved: true, generatedBy: { model: 'ChatGPT', fallback: false } },
  currentStep: 1,
  totalStepsSeen: 1,
  completedFields: {},
  unansweredFields: [],
  lastReport: {
    scannedAt: now - 30_000,
    url: 'https://jobs.lever.co/liftoff/123/apply',
    adapter: 'generic',
    totalFields: 12,
    requiredFields: 8,
    completedFields: 10,
    outstandingRequired: 1,
    filled: [{ fieldId: 'f1', actualValue: 'Agamyrat Akmyradov' }, { fieldId: 'f2', actualValue: 'a@example.com' }],
    ask: [{ field: field('f9', 'Desired salary (EUR)', 'text'), action: 'ASK', reason: 'No saved answer for salary.', reasonCode: 'NO_VALUE' }],
    skipped: [{ field: { ...field('f11', 'Gender', 'select', '', false), category: 'USER_CONFIRMATION_REQUIRED' }, action: 'SKIP', reason: 'Demographic questions are never answered automatically.', reasonCode: 'SENSITIVE' }],
    validationErrors: [],
    nextButtonLabel: 'Submit application',
    nextButtonKind: 'submit',
    fields: [
      field('f1', 'Full name', 'text', 'Agamyrat Akmyradov'),
      field('f2', 'Email', 'email', 'a@example.com'),
      field('f3', 'Phone', 'tel', '+40 791 392 970'),
      field('f4', 'Resume/CV', 'file', 'Agamyrat_Akmyradov_CV.pdf'),
      field('f9', 'Desired salary (EUR)', 'text', ''),
    ],
  },
  createdAt: now - 600_000,
  updatedAt: now,
}

const responses: Record<string, unknown> = {
  'auth/status': null,
  'source/status': { id: 'sheet-link', label: 'Google Sheet', connected: true, detail: 'Jobs - 7 rows', canWriteBack: true },
  'source/queue': { jobs, counts: { ready: 6, inProgress: 1, applied: 14, failed: 2, other: 0, total: 23 }, fetchedAt: now - 60_000 },
  'session/active': scenario === 'session' ? session : null,
  'ai/status': { id: 'chatgpt-project', label: 'ChatGPT', ready: true, detail: 'Your ChatGPT project' },
}

// --- chrome -----------------------------------------------------------------
/** Anything not stubbed: an object whose members are no-op async functions / listener holders. */
function loose(): unknown {
  const fn = () => Promise.resolve(undefined)
  return new Proxy(fn, {
    get: (_t, prop) => (prop === 'then' ? undefined : prop === 'addListener' || prop === 'removeListener' ? () => undefined : loose()),
    apply: () => Promise.resolve(undefined),
  })
}

const chromeStub = {
  storage: {
    local: storageLocal,
    session: storageLocal,
    onChanged: { addListener: (fn: never) => changeListeners.add(fn), removeListener: (fn: never) => changeListeners.delete(fn) },
  },
  runtime: {
    id: 'preview',
    lastError: undefined,
    getURL: (p: string) => `/${p}`,
    getManifest: () => ({ version: '0.1.0', name: 'JobApply Assistant' }),
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    async sendMessage(message: { type?: string; event?: string }) {
      if (!message?.type) return undefined
      const type = message.type
      if (type in responses) return { ok: true, data: responses[type] }
      return { ok: true, data: null }
    },
  },
}

;(globalThis as Record<string, unknown>).chrome = new Proxy(chromeStub as Record<string, unknown>, {
  get: (target, prop: string) => (prop in target ? target[prop] : loose()),
})

if (scenario === 'settings') sessionStorage.setItem('preview:settings', '1')
await import('../../extension/src/sidepanel/main.tsx')
