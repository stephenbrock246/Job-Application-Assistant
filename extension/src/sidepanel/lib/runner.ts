/**
 * The unattended run: applies to the job list by itself, in this panel's window.
 *
 * Per job:
 *   open the posting -> read the job -> tailor the CV in the user's chat ->
 *   into the form -> per page: autofill, uploads, written answers, Next ->
 *   last page: safety check -> "ready" (the worker notifies; the user approves)
 *
 * Anything only the user can do (an unknown question, a legal confirmation, a
 * page error) pauses that job as "needs help" with its tab left open, and the run
 * moves on to the next job. It never submits: submitting happens only when the
 * user approves, in the worker.
 *
 * It lives in the panel because tailoring and the chat runs are panel code. The
 * panel must stay open; if it closes, the run notices on reopen and offers Resume.
 */

import { useSyncExternalStore } from 'react'
import {
  AICancelledError,
  apiProviderId,
  getProviderFor,
  parseChatGptProjectUrl,
  tailorsViaProject,
  usesApiKey,
  usesChatContent,
  usesGptFile,
} from '@/ai'
import { tailorWithChatContent } from './chat-tailor'
import { setChatTabWindow } from '@/ai/chatgpt-project.provider'
import { composeTailoring, finishTailoring } from '@/resume/resume-tailor'
import { composeCoverLetter, finishCoverLetter } from '@/resume/cover-letter'
import { getApiKey } from '@/storage/credentials'
import { sendMessage } from '@/shared/utils/messaging'
import { jobUrlKey } from '@/shared/utils/job-url'
import { isCoverLetterUpload, preSubmitCheck } from '@/shared/utils/presubmit'
import { approveAndSaveResume, saveLetterPdf } from './writing-actions'
import { getSession } from '@/storage/sessions'
import { runSlot } from '@/storage/run'
import { masterResumeSlot, preferencesSlot, queueCacheSlot } from '@/storage/settings'
import { runAutopilotStep } from '../hooks/useAutopilot'
import { answerInChat, writtenQuestions } from './batch-answers'
import { tailorWithGptFile } from './gpt-resume'
import { runExclusive, taskKey, TaskBusyError, trackEvents } from './ai-activity'
import { reportPanelError } from './diagnostics'
import { MAX_WAITING, type RunItem, type RunState } from '@/shared/types/run'
import type { ApplicationSession } from '@/shared/types/application'
import type { WritingPatch } from '@/shared/types/messages'
import type { Preferences } from '@/shared/types/settings'

const MAX_PAGES = 15
/** States in which a job is waiting for the user; the run does not start another meanwhile. */
const WAITS_FOR_YOU: RunItem['state'][] = ['ready', 'submitting', 'needs-help', 'check']
const JOB_INFO_TIMEOUT_MS = 40_000
/** Sites whose terms forbid automated applying: listed as skipped, left to the user. */
const MANUAL_ONLY_HOSTS = /(^|\.)(wellfound\.com|angel\.co|linkedin\.com)$/i

/** Something only the user can do. The job pauses with this message; the run goes on. */
export class NeedsHelp extends Error {
  constructor(
    message: string,
    readonly problems?: string[],
  ) {
    super(message)
    this.name = 'NeedsHelp'
  }
}

// ---------------------------------------------------------------------------
// Whether this panel is running it (for the UI)
// ---------------------------------------------------------------------------

let controller: AbortController | null = null
/** The application the run is working on, so Stop can also cancel what the worker is doing for it. */
let currentSessionId: string | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

export function useRunnerActive(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => controller !== null,
  )
}

export interface RunSetup {
  /** API key mode: a key is saved for the chosen provider. */
  apiReady: boolean
  hasMaster: boolean
}

export async function runSetup(prefs: Preferences): Promise<RunSetup> {
  const [key, master] = await Promise.all([
    getApiKey(apiProviderId(prefs) === 'openai-api' ? 'openai' : 'gemini'),
    masterResumeSlot.get(),
  ])
  return { apiReady: Boolean(key), hasMaster: Boolean(master && (master.text.trim() || master.docxBase64)) }
}

/** What has to be set up before a run can work, worded for the panel. Empty when ready. */
export function runSetupProblems(prefs: Preferences, setup: RunSetup): string[] {
  const problems: string[] = []
  if (usesApiKey(prefs)) {
    const name = apiProviderId(prefs) === 'openai-api' ? 'OpenAI' : 'Gemini'
    if (!setup.apiReady) problems.push(`Add your ${name} API key in Settings > AI.`)
    if (!setup.hasMaster) problems.push(`Add your master resume in Settings > Resume - ${name} tailors it for each job.`)
  } else if (!tailorsViaProject(prefs)) {
    problems.push('Set up your tailoring chat, or add a free Gemini API key, in Settings > AI.')
  } else if (usesChatContent(prefs) && !setup.hasMaster) {
    problems.push('Add your master resume in Settings > Resume - the CV is built from it with your chat\'s text.')
  }
  if (!prefs.autoAttachFiles) problems.push('Turn on automatic uploads in Settings > AI.')
  return problems
}

/** True from the moment a start is requested until its loop owns the run (or the start fails). */
let starting = false

export async function startRunner(): Promise<void> {
  // Claimed before the first await: two quick presses (Start, Continue) must not start two loops.
  if (controller || starting) return
  starting = true
  try {
    const prefs = await preferencesSlot.get()
    const problems = runSetupProblems(prefs, await runSetup(prefs))
    if (problems.length) throw new Error(problems.join(' '))
    const window = await chrome.windows.getCurrent()
    if (window.id === undefined) throw new Error('Could not tell which window this panel is in.')
    await sendMessage('run/start', { windowId: window.id })
    void loop(window.id)
  } finally {
    starting = false
  }
}

export async function stopRunner(): Promise<void> {
  controller?.abort()
  // Work already handed to the worker for this job (a Next in flight) stops too.
  if (currentSessionId) await sendMessage('page/cancelNext', { sessionId: currentSessionId }).catch(() => undefined)
  await sendMessage('run/stop', { status: 'Stopped by you.' })
}

/** The user fixed what a paused job needed: finish it next (starting the run if it is not running). */
export async function continueJob(item: RunItem): Promise<void> {
  // The user may have opened the application form themselves - in this tab or a new one.
  if (item.sessionId) await sendMessage('job/adoptViewedTab', { sessionId: item.sessionId }).catch(() => null)
  await sendMessage('run/item', { ...item, retry: true, reason: 'Continuing next...' })
  if (!controller) await startRunner()
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let lastStatus = ''

async function progress(status: string, currentKey?: string | null): Promise<void> {
  lastStatus = status
  await sendMessage('run/progress', { status, ...(currentKey !== undefined ? { currentKey } : {}) }).catch(() => undefined)
}

async function loop(windowId: number): Promise<void> {
  const own = new AbortController()
  controller = own
  emit()
  setChatTabWindow(windowId)
  // A sign of life, so a panel opened later can tell a live run from one cut off.
  const beat = setInterval(() => void progress(lastStatus), 20_000)

  try {
    while (!own.signal.aborted) {
      const run = await runSlot.get()
      if (run.mode !== 'running') break

      const retry = Object.values(run.items).find((item) => item.retry)
      if (retry) {
        await applyTo(jobOf(retry), windowId, own.signal, retry)
        continue
      }

      // One job at a time: nothing new starts while a job waits for the user.
      const waiting = Object.values(run.items).filter((item) => WAITS_FOR_YOU.includes(item.state))
      if (waiting.length >= MAX_WAITING) {
        const first = waiting[0]!
        await progress(
          first.state === 'ready' || first.state === 'submitting'
            ? `Waiting for your approval: ${first.company}. Submit or skip it, then the next job starts.`
            : `Waiting for you: ${first.company} needs your help. Fix it and press Continue, or Skip it.`,
          null,
        )
        await sleep(3_000, own.signal)
        continue
      }

      const job = await nextJob(run)
      if (!job) {
        await sendMessage('run/stop', { status: 'Finished: no more Ready jobs in the list.' })
        break
      }
      await applyTo(job, windowId, own.signal)
    }
  } catch (error) {
    if (!own.signal.aborted) {
      reportPanelError(error, 'run')
      await sendMessage('run/stop', { status: `Stopped: ${errorText(error)}` }).catch(() => undefined)
    }
  } finally {
    clearInterval(beat)
    currentSessionId = null
    setChatTabWindow(undefined)
    if (controller === own) controller = null
    emit()
  }
}

interface RunJob {
  id?: string
  key: string
  jobLink: string
  company: string
  position: string
}

function jobOf(item: RunItem): RunJob {
  return { key: item.key, jobLink: item.jobLink, company: item.company, position: item.position }
}

/** The first Ready job not yet in this run. Sites that forbid automation are listed as skipped. */
async function nextJob(run: RunState): Promise<RunJob | null> {
  // The list as last read is good enough to pick the next job when the sheet cannot be re-read right now.
  const queue = await sendMessage('source/queue', { force: true }).catch(async (error: unknown) => {
    const cached = await queueCacheSlot.get()
    if (!cached) throw error
    return cached
  })
  for (const job of queue.jobs) {
    if (job.status !== 'READY' || !job.jobLink) continue
    const key = jobUrlKey(job.jobLink)
    if (run.items[key]) continue
    const entry = { key, jobLink: job.jobLink, company: job.company, position: job.position }
    if (manualOnly(job.jobLink)) {
      await sendMessage('run/item', {
        ...entry,
        state: 'skipped',
        reason: 'This site does not allow automated applying. Apply by hand.',
        at: Date.now(),
      })
      continue
    }
    return { id: job.id, ...entry }
  }
  return null
}

function manualOnly(link: string): boolean {
  try {
    return MANUAL_ONLY_HOSTS.test(new URL(link).hostname)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

/**
 * Applies to one job up to the point of submitting. `resume`: a paused job the
 * user fixed - it carries on in its open tab rather than reloading the posting
 * (which would lose what they typed).
 */
export async function applyTo(job: RunJob, windowId: number, signal: AbortSignal, resume?: RunItem): Promise<void> {
  const item: RunItem = {
    key: job.key,
    jobLink: job.jobLink,
    company: job.company,
    position: job.position,
    state: 'working',
    at: Date.now(),
    ...(resume?.sessionId ? { sessionId: resume.sessionId } : {}),
  }
  const save = (patch: Partial<RunItem> = {}) => sendMessage('run/item', { ...item, ...patch, at: Date.now() })
  const step = (status: string) => progress(`${item.company || 'Job'}: ${status}`, item.key)

  try {
    await save()
    let session: ApplicationSession | null = null

    if (resume?.sessionId) {
      session = await getSession(resume.sessionId)
      if (!session) throw new NeedsHelp('This application was closed. Open the job again by hand.')
    } else {
      if (!job.id) throw new NeedsHelp('This job is no longer in the list.')
      await step('opening the job...')
      const opened = await sendMessage('job/open', { jobId: job.id, windowId })
      item.sessionId = opened.id
      await save()
      session = await waitForSession(opened.id, (s) => Boolean(s.jobInfo), JOB_INFO_TIMEOUT_MS, signal)
      if (!session?.jobInfo) throw new NeedsHelp('Could not read the job posting.')
    }
    item.company = session.company || item.company
    item.position = session.position || item.position
    const sessionId = session.id
    currentSessionId = sessionId
    const prefs = await preferencesSlot.get()

    if (!session.resume?.approved) {
      if ((session.jobInfo?.confidence ?? 0) < 0.5) {
        throw new NeedsHelp('The job description could not be read reliably. Check or paste it, then press Continue.')
      }
      const current = session
      // A tailored resume left unapproved is waiting for the user's review, not for a redo.
      if (current.resume && !usesGptFile(prefs)) {
        throw new NeedsHelp('The tailored resume is waiting for your review. Approve & save it in step 1, then press Continue.')
      }
      if (usesApiKey(prefs)) {
        await step('tailoring the resume...')
        await tailorWithApi(current, prefs, signal, step)
      } else if (usesChatContent(prefs)) {
        await step('your chat is tailoring the CV...')
        await exclusive(sessionId, 'resume', signal, (report, own) =>
          tailorWithChatContent(current, prefs, updateFor(sessionId), {
            signal: own,
            report: (message) => {
              report(message)
              void step(message)
            },
          }),
        )
        // Only with "use right away" off does it wait here; otherwise findings are shown at approval.
        const tailored = (await requireSession(sessionId)).resume
        if (!tailored?.approved) {
          const flagged = tailored?.warnings.filter((warning) => !warning.message.startsWith('Ignored:')) ?? []
          throw new NeedsHelp(
            flagged.length
              ? `The tailored CV is ready for your review (${flagged.length} thing${flagged.length === 1 ? '' : 's'} to check). Approve & save it in step 1, then press Continue.`
              : 'The tailored CV is ready for your review. Approve & save it in step 1, then press Continue.',
            flagged.map((warning) => warning.message),
          )
        }
      } else {
        await step('your chat is creating the CV...')
        await exclusive(sessionId, 'resume', signal, (report, own) =>
          tailorWithGptFile(current, prefs, updateFor(sessionId), {
            signal: own,
            report: (message) => {
              report(message)
              void step(message)
            },
          }),
        )
      }
    }

    await step('opening the application form...')
    const entry = await sendMessage('page/enterForm', { sessionId })
    if (!entry.entered) throw new NeedsHelp(entry.message)

    for (let page = 1; ; page += 1) {
      throwIfStopped(signal)
      if (page > MAX_PAGES) throw new NeedsHelp(`Still not at the end of the form after ${MAX_PAGES} pages.`)

      await step(`page ${page} - filling...`)
      throwIfStopped(signal)
      await sendMessage('page/autofill', { sessionId, auto: true })
      await coverLetterIfAsked(sessionId, prefs, signal, step)
      await uploads(sessionId, signal)

      const now = await requireSession(sessionId)
      const questions = writtenQuestions(now)
      if (questions.length) {
        if (!usesApiKey(prefs) && !parseChatGptProjectUrl(prefs.chatgptAnswersUrl)) {
          throw new NeedsHelp(
            `${questions.length} written question${questions.length === 1 ? '' : 's'} on this page. Add your answers chat link in Settings > AI, or answer them yourself, then press Continue.`,
          )
        }
        await step(`page ${page} - answering ${questions.length} written question${questions.length === 1 ? '' : 's'}...`)
        const outcome = await exclusive(sessionId, 'answers', signal, (report, own) =>
          answerInChat(now, prefs, questions, updateFor(sessionId), { signal: own, report }),
        )
        if (outcome.failed.length) throw new NeedsHelp(`Could not type the answer into: ${outcome.failed.join('; ')}`, outcome.failed)
        if (outcome.needsFact.length) {
          throw new NeedsHelp(
            `An answer needs a fact only you know: ${outcome.needsFact.join('; ')}. Its draft is in the panel; finish it on the page, then press Continue.`,
            outcome.needsFact,
          )
        }
      }

      await step(`page ${page} - continuing...`)
      throwIfStopped(signal)
      const navigation = await sendMessage('page/next', { sessionId })
      if (navigation.outcome === 'ADVANCED') continue
      if (navigation.outcome === 'SUBMIT_REFUSED') break
      if (navigation.outcome === 'BLOCKED') {
        const labels = (navigation.blockingFields ?? []).map((field) => field.label.replace(/\s*\*\s*$/, ''))
        throw new NeedsHelp(labels.length ? `Needs your answer: ${labels.join('; ')}` : navigation.message, labels)
      }
      throw new NeedsHelp(navigation.message)
    }

    await step('safety check...')
    const report = await sendMessage('page/scan', { sessionId, auto: true })
    const check = preSubmitCheck(await requireSession(sessionId), report)
    if (check.blocking.length) throw new NeedsHelp(check.blocking[0]!, check.blocking)

    await save({ state: 'ready', ...(check.notes.length ? { reason: check.notes[0], problems: check.notes } : {}) })
  } catch (error) {
    if (signal.aborted) {
      await save({ state: 'needs-help', reason: 'The run was stopped while this one was being filled.' }).catch(() => undefined)
      return
    }
    const problems = error instanceof NeedsHelp ? error.problems : undefined
    await save({ state: 'needs-help', reason: errorText(error), ...(problems?.length ? { problems } : {}) }).catch(() => undefined)
    // A pause is expected; a crash in the runner is a bug worth a report.
    if (!(error instanceof NeedsHelp)) reportPanelError(error, 'run')
  }
}

/**
 * API key mode: tailors the master resume for this job and saves it like the
 * Approve button does ("use right away" on); its fact-check findings stay on it
 * and are shown when the user approves the submit.
 */
async function tailorWithApi(
  session: ApplicationSession,
  prefs: Preferences,
  signal: AbortSignal,
  step: (status: string) => Promise<void>,
): Promise<void> {
  const master = await masterResumeSlot.get()
  if (!master) throw new NeedsHelp('Add your master resume in Settings > Resume.')
  const provider = await getProviderFor('resume')
  const task = await composeTailoring(session, {})
  const reply = await exclusive(session.id, 'resume', signal, (report, own) => {
    const events = trackEvents((message) => {
      report(message)
      void step(message)
    }, provider.label)
    return provider.complete!(task.prompt, { signal: own, onEvent: events.onEvent })
  })

  const { state, ignored } = await finishTailoring(session, task, reply)
  const update = updateFor(session.id)
  await update({
    resume: { ...state, warnings: [...ignored.map((message) => ({ message: `Ignored: ${message}` })), ...state.warnings] },
    resumeApproved: false,
    tailoredResume: null,
  })
  if (!prefs.autoApproveClean) {
    throw new NeedsHelp(
      'The tailored resume is ready for your review. Approve & save it in step 1, then press Continue.',
      state.warnings.map((warning) => warning.message),
    )
  }
  // Saved and used now; what the fact check found is shown when the user approves the submit.
  await approveAndSaveResume(await requireSession(session.id), master, update)
}

/**
 * Writes the cover letter when this page has a cover letter upload or text box
 * and there is none yet. (In chat mode the tailoring chat normally sends it with the CV.)
 */
async function coverLetterIfAsked(
  sessionId: string,
  prefs: Preferences,
  signal: AbortSignal,
  step: (status: string) => Promise<void>,
): Promise<void> {
  if (!prefs.autoCoverLetter || !(usesApiKey(prefs) || usesChatContent(prefs))) return
  const session = await requireSession(sessionId)
  if (session.coverLetter?.approved) return
  const asked = (session.lastReport?.fields ?? []).some(
    (field) =>
      !field.value &&
      ((field.type === 'file' && isCoverLetterUpload(field.label)) ||
        (field.canonicalField === 'coverLetter' && (field.type === 'textarea' || field.type === 'text'))),
  )
  if (!asked) return
  if (session.coverLetter) throw new NeedsHelp('The cover letter is waiting for your review. Approve it in step 1, then press Continue.')
  // Chat mode: the tailoring reply brings the letter; without one, only the answers chat can write it.
  if (!usesApiKey(prefs) && !parseChatGptProjectUrl(prefs.chatgptAnswersUrl)) return

  await step('writing the cover letter...')
  const provider = await getProviderFor('coverLetter')
  const task = await composeCoverLetter(session, {})
  const reply = await exclusive(sessionId, 'coverLetter', signal, (report, own) =>
    provider.complete!(task.prompt, { signal: own, onEvent: trackEvents(report, provider.label).onEvent }),
  )
  const letter = await finishCoverLetter(session, task, reply)
  const update = updateFor(sessionId)
  if (!prefs.autoApproveClean) {
    await update({ coverLetter: letter })
    throw new NeedsHelp('The cover letter is ready for your review. Approve it in step 1, then press Continue.', letter.warnings.map((warning) => warning.message))
  }
  // Used now; its fact-check findings are listed when the user approves the submit.
  await update({ coverLetter: { ...letter, approved: true } })
  await saveLetterPdf(await requireSession(sessionId), letter.text)
}

/** Uploads (CV, cover letter) and the cover letter text box, until none is left. */
async function uploads(sessionId: string, signal: AbortSignal): Promise<void> {
  const [master, prefs] = await Promise.all([masterResumeSlot.get(), preferencesSlot.get()])
  for (let round = 0; round < 8; round += 1) {
    throwIfStopped(signal)
    const outcome = await runAutopilotStep(await requireSession(sessionId), master, prefs)
    if (outcome === 'idle') return
    // The panel's own autopilot is doing one for this application; let it finish.
    if (outcome === 'busy') await sleep(1_000, signal)
  }
}

/** Runs an AI task under its exclusive key, cancelled by Stop as well as by its own Cancel. */
async function exclusive<T>(
  sessionId: string,
  task: string,
  signal: AbortSignal,
  work: (report: (message: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await runExclusive(taskKey(sessionId, task), 'Working...', (report, own) => work(report, AbortSignal.any([own, signal])))
  } catch (error) {
    if (error instanceof TaskBusyError) throw new NeedsHelp('This step is already running by hand in the panel.')
    if (error instanceof AICancelledError && !signal.aborted) throw new NeedsHelp('Cancelled in the panel.')
    throw error
  }
}

function updateFor(sessionId: string): (patch: WritingPatch) => Promise<void> {
  return async (patch) => {
    await sendMessage('session/updateWriting', { sessionId, patch })
  }
}

async function requireSession(sessionId: string): Promise<ApplicationSession> {
  const session = await getSession(sessionId)
  if (!session) throw new NeedsHelp('This application was closed.')
  return session
}

async function waitForSession(
  sessionId: string,
  ready: (session: ApplicationSession) => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ApplicationSession | null> {
  const deadline = Date.now() + timeoutMs
  let session = await getSession(sessionId)
  while (session && !ready(session) && Date.now() < deadline) {
    throwIfStopped(signal)
    await sleep(1_000, signal)
    session = await getSession(sessionId)
  }
  throwIfStopped(signal)
  return session
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new AICancelledError()
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  // Already stopped: an abort listener added now would never fire - return at once.
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
