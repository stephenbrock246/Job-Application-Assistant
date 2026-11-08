/**
 * Unattended run check.
 *
 *   npm run check:run
 *
 * 1. Safety check before submit: empty required fields, legal questions, page
 *    errors, a missing resume (and a site that clears its file input).
 * 2. Clicks: "Apply" opens the form; Next never clicks Submit; the approved
 *    submit clicks only a real Submit.
 * 3. Run state + notifications: Ready / Needs help notify with the right buttons,
 *    an interrupted job is not left "working", dismiss clears the notification.
 * 4. The runner, end to end against a simulated worker: a two-page form ends
 *    "ready" (never submitted); a question it cannot answer pauses that job and
 *    the run goes on; a site that forbids automation is skipped; Stop stops.
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://jobs.example.com/acme/1', pretendToBeVisual: true })
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.location = dom.window.location
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'HTMLButtonElement', 'Element', 'Node']) {
  g[name] = (dom.window as unknown as Record<string, unknown>)[name]
}
// jsdom has no layout: every element gets a size, so "visible" checks pass.
dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 80, height: 20, top: 0, left: 0, right: 80, bottom: 20, x: 0, y: 0, toJSON() {} })

const store = new Map<string, unknown>()
const sessionStore = new Map<string, unknown>()
const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k])
const area = (map: Map<string, unknown>) => ({
  get: async (k: string | string[]) =>
    Object.fromEntries(keys(k).filter((key) => map.has(key)).map((key) => [key, structuredClone(map.get(key))])),
  set: async (items: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value))
  },
  remove: async (k: string | string[]) => keys(k).forEach((key) => map.delete(key)),
})
const notifications = new Map<string, { title: string; message: string; buttons?: { title: string }[] }>()
type Handler = (payload: never) => unknown
const handlers: Record<string, Handler> = {}
const sent: { type: string; payload: unknown }[] = []

g.chrome = {
  storage: {
    local: area(store),
    session: area(sessionStore),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  notifications: {
    create: async (id: string, options: { title: string; message: string; buttons?: { title: string }[] }) => void notifications.set(id, options),
    clear: async (id: string) => notifications.delete(id),
  },
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    // The simulated worker: the runner talks to it exactly as to the real one.
    sendMessage: async (message: { type: string; payload: unknown }) => {
      sent.push(message)
      const handler = handlers[message.type]
      if (!handler) return { ok: false, error: `no handler for ${message.type}` }
      try {
        return { ok: true, data: await handler(message.payload as never) }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    },
  },
  windows: { getCurrent: async () => ({ id: 7 }) },
}

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

console.log('\n--- Safety check before submit ----------------------------------\n')

const { preSubmitCheck } = await import('../extension/src/shared/utils/presubmit.ts')
{
  const field = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, type: 'text', required: true, value: 'x', ...extra })
  const base = { id: 's', answers: {}, autopilot: {} } as never
  const report = (fields: unknown[], extra: Record<string, unknown> = {}) => ({ url: 'https://jobs.example.com/acme/1/apply', fields, validationErrors: [], ...extra }) as never

  const clean = preSubmitCheck(base, report([field('a', 'Name *'), field('cv', 'Resume/CV', { type: 'file', value: 'Acme_Resume.pdf' })]))
  expect(clean.blocking.length === 0 && clean.notes.length === 0, 'a complete page passes')

  const empty = preSubmitCheck(base, report([field('a', 'Phone *', { value: '' })]))
  expect(empty.blocking.length === 1 && /Phone/.test(empty.blocking[0]!) && !/\*/.test(empty.blocking[0]!), 'an empty required field blocks, named without "*"')

  const legal = preSubmitCheck(base, report([field('sig', 'Signature', { value: '', category: 'USER_CONFIRMATION_REQUIRED' })]))
  expect(/needs your own answer/.test(legal.blocking[0] ?? ''), 'a legal confirmation is left to you')

  const unknown = preSubmitCheck(base, report([field('w', 'Start date', { value: '', valueUnknown: true })]))
  expect(unknown.blocking.length === 0 && unknown.notes.length === 1, 'an unreadable control is a note, not a block')

  const errors = preSubmitCheck(base, report([], { validationErrors: [{ message: 'Email is invalid' }] }))
  expect(/Email is invalid/.test(errors.blocking[0] ?? ''), 'an error shown on the page blocks')

  const noCv = preSubmitCheck(base, report([field('cv', 'Resume', { type: 'file', value: '' })]))
  expect(noCv.blocking.some((b) => /resume is not attached/i.test(b)), 'an empty resume upload blocks')
  const optionalCv = preSubmitCheck(base, report([field('cv', 'Resume', { type: 'file', value: '', required: false })]))
  expect(/resume is not attached/i.test(optionalCv.blocking[0] ?? ''), 'even when the site marks the resume optional')

  const cleared = preSubmitCheck(
    { ...(base as object), autopilot: { attached: { 'cv@https://jobs.example.com/acme/1/apply': { fileName: 'Acme_Resume.pdf', ok: true, at: 1 } } } } as never,
    report([field('cv', 'Resume', { type: 'file', value: '' })]),
  )
  expect(cleared.blocking.length === 0, 'a site that clears its file input after upload still counts as attached')

  const flaggedCv = preSubmitCheck(
    { ...(base as object), resume: { approved: true, warnings: [{ message: '"Vue.js" comes from the job description and is not in your master resume.' }, { message: 'Ignored: x' }] } } as never,
    report([]),
  )
  expect(
    flaggedCv.blocking.length === 0 && /Tailored CV - 1 thing to check: "Vue\.js"/.test(flaggedCv.notes[0] ?? ''),
    'what the fact check found in the CV is shown when you approve - it does not stop the job',
  )

  const warned = preSubmitCheck({ ...(base as object), answers: { q: { question: 'Why us?', warnings: [{ message: 'Mentions 10 years' }] } } } as never, report([]))
  expect(warned.blocking.length === 0 && /Why us\?/.test(warned.notes[0] ?? ''), 'a fact-check warning on an answer is a note to look at')
}

console.log('\n--- Apply / Next / Submit clicks --------------------------------\n')

{
  const { clickApplyEntry, clickApprovedSubmit, clickNext } = await import('../extension/src/content/navigation/next-button.ts')
  const document = dom.window.document
  const tick = () => new Promise((resolve) => setTimeout(resolve, 60))

  let clicks: string[] = []
  const track = () => document.querySelectorAll('button, a').forEach((el) => el.addEventListener('click', (e) => { e.preventDefault(); clicks.push((el.textContent ?? '').trim()) }))

  document.body.innerHTML = '<nav><a href="#">Careers</a></nav><h1>Engineer</h1><a href="#apply">Apply for this job</a>'
  track()
  expect(clickApplyEntry().clicked, '"Apply for this job" is found on a posting')
  await tick()
  expect(clicks.includes('Apply for this job') && !clicks.includes('Careers'), 'and only that is clicked')

  // SmartRecruiters: "I’m interested", often with a curly apostrophe, next to "Refer a friend".
  document.body.innerHTML = '<button type="button">Refer a friend</button><button type="button">I’m interested</button>'
  clicks = []
  track()
  expect(clickApplyEntry().clicked, 'SmartRecruiters "I’m interested" (curly apostrophe) is found')
  await tick()
  expect(clicks.length === 1 && clicks[0] === 'I’m interested', 'and clicked - not "Refer a friend"')

  document.body.innerHTML = '<div role="tablist"><a role="tab" href="#o">Overview</a><a role="tab" href="#a">Application</a></div>'
  clicks = []
  track()
  expect(clickApplyEntry().clicked, 'Ashby-style "Application" tab is found')
  await tick()
  expect(clicks.includes('Application'), 'and clicked')

  document.body.innerHTML = '<form><input name="n"><button type="button">Submit application</button></form>'
  clicks = []
  track()
  const next = clickNext()
  expect(!next.clicked && next.reason === 'SUBMIT_REFUSED', 'Next never presses a final Submit')
  await tick()
  expect(clicks.length === 0, 'nothing was clicked')

  const approved = clickApprovedSubmit()
  await tick()
  expect(approved.clicked && clicks.includes('Submit application'), 'the approved submit presses Submit')

  document.body.innerHTML = '<form><input name="n"><button type="button">Next</button></form>'
  clicks = []
  track()
  const notFinal = clickApprovedSubmit()
  await tick()
  expect(!notFinal.clicked && clicks.length === 0, 'the approved submit will not press anything that is not a final Submit')
}

console.log('\n--- Getting into the form ----------------------------------------\n')

{
  const { nextEnterAction } = await import('../extension/src/navigation/enter-form.ts')
  const { embeddedForms } = await import('../extension/src/content/navigation/page-state.ts')
  const none = { elapsedMs: 4_000, opened: new Set<string>(), pressed: new Set<string>() }
  const text = (n: number) => Array.from({ length: n }, () => ({ type: 'text' }))

  // cast.ai: its own job-alert form (WordPress Gravity Forms, with a hidden helper frame)
  // plus the real application form - Greenhouse, in a frame.
  const document = dom.window.document
  document.body.innerHTML = `
    <form id="gform_1"><input name="first"><input name="last"><input name="email"><input type="checkbox" name="consent"></form>
    <iframe style="display:none" src="about:blank" name="gform_ajax_frame_1"></iframe>
    <div id="grnhse_app"><iframe id="grnhse_iframe" src="https://job-boards.greenhouse.io/embed/job_app?for=castaigroupinc&token=4472184009"></iframe></div>
    <a href="#grnhse_app">Apply for this role</a>`
  const frames = embeddedForms()
  expect(frames.length === 1 && frames[0]!.includes('job-boards.greenhouse.io/embed/job_app') && frames[0]!.includes('token=4472184009'), 'the Greenhouse form frame is found (the hidden helper frame is not)')

  const castai = nextEnterAction({ fields: text(4), embeddedForms: frames, applyEntry: 'Apply for this role' }, none)
  expect(castai.kind === 'open' && castai.url === frames[0], 'cast.ai: the Greenhouse form is opened - the job-alert boxes are not mistaken for the application')
  const afterOpen = nextEnterAction({ fields: [...text(6), { type: 'file' }], embeddedForms: [], applyEntry: null }, { ...none, opened: new Set(frames) })
  expect(afterOpen.kind === 'entered', 'on the opened Greenhouse form (fields and an upload): the form is reached')

  const ownForm = nextEnterAction({ fields: [...text(5), { type: 'file' }], embeddedForms: ['https://boards.greenhouse.io/embed/job_board?for=x'], applyEntry: null }, none)
  expect(ownForm.kind === 'entered', 'a page whose own form has an upload field is the form, whatever else it embeds')
  const posting = nextEnterAction({ fields: text(2), embeddedForms: [], applyEntry: 'I’m interested' }, none)
  expect(posting.kind === 'press', 'a posting with two stray boxes and "I’m interested": the button is pressed')
  const pressedOnce = nextEnterAction({ fields: text(2), embeddedForms: [], applyEntry: 'I’m interested' }, { ...none, pressed: new Set(['I’m interested']) })
  expect(pressedOnce.kind === 'wait', 'and only once')
  const small = nextEnterAction({ fields: text(3), embeddedForms: [], applyEntry: null }, none)
  expect(small.kind === 'entered', 'a small form with no Apply button and nothing embedded is the form')
  const opening = nextEnterAction({ fields: [], embeddedForms: [], applyEntry: null }, { ...none, elapsedMs: 500 })
  expect(opening.kind === 'wait', 'a page still loading: wait')
}

console.log('\n--- Run state and notifications ---------------------------------\n')

const run = await import('../extension/src/background/run.ts')
const { runSlot } = await import('../extension/src/storage/run.ts')
{
  const item = { key: 'k1', jobLink: 'https://jobs.example.com/acme/1', company: 'Acme', position: 'Engineer', sessionId: 's1', at: 1 }
  await run.setRunItem({ ...item, state: 'working' })
  expect(!notifications.has('run:k1'), 'no notification while it is being filled')

  await run.setRunItem({ ...item, state: 'ready', problems: ['Check the answer to "Why us?"'] })
  const ready = notifications.get('run:k1')
  expect(/Ready to submit: Acme/.test(ready?.title ?? '') && /1 thing worth a look/.test(ready?.message ?? ''), 'Ready notifies, mentioning what to look at')
  expect(JSON.stringify(ready?.buttons?.map((b) => b.title)) === '["Review","Submit"]', 'with Review and Submit buttons')
  expect(JSON.stringify(run.NOTIFICATION_BUTTONS.ready) === '["review","submit"]', 'button 2 maps to submit')

  await run.setRunItem({ ...item, key: 'k2', state: 'needs-help', reason: 'Needs your answer: Salary' })
  const help = notifications.get('run:k2')
  expect(/Needs your help: Acme/.test(help?.title ?? '') && help?.message === 'Needs your answer: Salary', 'Needs help notifies with the reason')
  expect(JSON.stringify(help?.buttons?.map((b) => b.title)) === '["Open"]', 'with an Open button only (no Submit)')

  await run.setRunItem({ ...item, key: 'k3', state: 'working' })
  await run.startRun(9)
  const state = await runSlot.get()
  expect(state.mode === 'running' && state.windowId === 9, 'start records the run window')
  expect(state.items.k3?.state === 'needs-help', 'a job left "working" by an interrupted run becomes needs-help')

  await run.dismissRunItem('k2')
  expect(!notifications.has('run:k2') && !(await runSlot.get()).items.k2, 'dismiss removes it and its notification')
  await run.stopRun()
  expect((await runSlot.get()).mode === 'idle', 'stop ends the run')
  await runSlot.clear()
  notifications.clear()
}

console.log('\n--- The runner, end to end --------------------------------------\n')

{
  const { sessionsSlot } = await import('../extension/src/storage/sessions.ts')
  const { preferencesSlot, masterResumeSlot } = await import('../extension/src/storage/settings.ts')
  const runWorker = await import('../extension/src/background/run.ts')
  await preferencesSlot.set({
    ...(await preferencesSlot.get()),
    tailorVia: 'chatgpt-project',
    tailorOutput: 'file',
    chatgptProjectUrl: 'https://chatgpt.com/c/68f0a1b2-1234-8000-9abc-0123456789ab',
    chatgptAnswersUrl: '',
    autoAttachFiles: true,
  } as never)
  await masterResumeSlot.set(null as never)

  const jobs = [
    { id: 'j1', rowNumber: 2, status: 'READY', jobLink: 'https://jobs.ashbyhq.com/acme/1', company: 'Acme', position: 'Engineer' },
    { id: 'j2', rowNumber: 3, status: 'READY', jobLink: 'https://www.linkedin.com/jobs/view/2', company: 'Linked', position: 'Dev' },
    { id: 'j3', rowNumber: 4, status: 'READY', jobLink: 'https://jobs.lever.co/beta/3', company: 'Beta', position: 'Backend' },
    { id: 'j4', rowNumber: 5, status: 'APPLIED', jobLink: 'https://x.io/4', company: 'Done', position: 'Old' },
  ]
  // Each job's form: pages of Next outcomes. Beta has a question nobody can answer.
  const script: Record<string, string[]> = { j1: ['ADVANCED', 'SUBMIT_REFUSED'], j3: ['BLOCKED'] }
  const opened: string[] = []
  const nextCalls: Record<string, number> = {}
  const sessionJob = new Map<string, string>()
  let submitted = 0

  const session = (id: string, job: (typeof jobs)[number]) => ({
    id,
    sheetRow: job.rowNumber,
    spreadsheetId: 'csv',
    sheetName: 'jobs.csv',
    jobUrl: job.jobLink,
    company: job.company,
    position: job.position,
    currentStep: 1,
    totalStepsSeen: 1,
    completedFields: {},
    unansweredFields: [],
    status: 'APPLYING',
    // Already tailored, so no chat is needed here.
    resume: { approved: true, edits: [], warnings: [], changeNotes: [] },
    jobInfo: { title: job.position, company: job.company, location: '', description: 'A job.', source: 'page', confidence: 0.9, extractedAt: 1 },
    createdAt: 1,
    updatedAt: 1,
  })

  Object.assign(handlers, {
    'run/start': (p: { windowId: number }) => runWorker.startRun(p.windowId),
    'run/stop': (p?: { status?: string }) => runWorker.stopRun(p?.status),
    'run/progress': (p: { status: string; currentKey?: string | null }) => runWorker.runProgress(p.status, p.currentKey),
    'run/item': (item: never) => runWorker.setRunItem(item),
    'source/queue': () => ({ jobs, counts: {}, fetchedAt: Date.now() }),
    'job/open': async (p: { jobId: string; windowId?: number }) => {
      const job = jobs.find((j) => j.id === p.jobId)!
      opened.push(`${p.jobId}@${p.windowId}`)
      const id = `s-${p.jobId}`
      sessionJob.set(id, p.jobId)
      await sessionsSlot.update((all) => ({ ...all, [id]: session(id, job) as never }))
      return session(id, job)
    },
    'page/enterForm': () => ({ entered: true, message: 'The form is on the job page.' }),
    'page/autofill': () => ({}),
    'page/scan': () => ({ url: 'https://jobs.ashbyhq.com/acme/1/application', fields: [{ id: 'n', label: 'Name', type: 'text', required: true, value: 'Daniel' }], validationErrors: [] }),
    'page/next': (p: { sessionId: string }) => {
      const jobId = sessionJob.get(p.sessionId)!
      const n = (nextCalls[jobId] = (nextCalls[jobId] ?? 0) + 1)
      const outcome = script[jobId]![n - 1] ?? 'NO_CONTROL'
      return {
        outcome,
        message: outcome === 'BLOCKED' ? '1 required field still empty.' : outcome,
        fromStep: n,
        toStep: n + 1,
        errors: [],
        ...(outcome === 'BLOCKED' ? { blockingFields: [{ id: 'sal', label: 'Expected salary *', type: 'text', required: true }] } : {}),
      }
    },
    'run/approve': () => {
      submitted++
      return null
    },
  })

  const runner = await import('../extension/src/sidepanel/lib/runner.ts')
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50))
  const item = async (company: string) => Object.values((await runSlot.get()).items).find((i) => i.company === company)
  /** Waits (up to ~6s) until `done` holds. */
  const until = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 120 && !(await done()); i++) await tick()
  }

  await runner.startRunner()
  await until(async () => (await item('Acme'))?.state === 'ready' && /approval/.test((await runSlot.get()).status))
  const acme = await item('Acme')

  expect(opened.length === 1 && opened[0] === 'j1@7', `the job opens in the run's window (${opened.join(', ')})`)
  expect(acme?.state === 'ready', 'a two-page form ends "ready for approval"')
  expect(submitted === 0 && !sent.some((m) => m.type === 'run/approve'), 'the runner never submits by itself')
  expect(notifications.get(`run:${acme?.key}`)?.title === 'Ready to submit: Acme', 'you are notified that it is ready')
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect(opened.length === 1 && (await runSlot.get()).mode === 'running', 'it does NOT open another job before you approve')
  expect(/Waiting for your approval: Acme/.test((await runSlot.get()).status), 'and says it is waiting for your approval')

  // You approve; the site confirms -> submitted. Only now does the next job start.
  await runWorker.setRunItem({ ...acme!, state: 'submitted' })
  await until(async () => (await item('Beta'))?.state === 'needs-help')
  const beta = await item('Beta')
  const linked = await item('Linked')
  expect(linked?.state === 'skipped' && !opened.some((o) => o.startsWith('j2')), 'after you approve, it goes on: LinkedIn is skipped, never opened')
  expect(beta?.state === 'needs-help' && /Expected salary/.test(beta.reason ?? '') && !/\*/.test(beta.reason ?? ''), 'a question it cannot answer pauses that job, naming the question')
  await new Promise((resolve) => setTimeout(resolve, 400))
  expect((await runSlot.get()).mode === 'running' && /needs your help/.test((await runSlot.get()).status), 'and it waits for you there too, instead of moving on')
  expect(!Object.values((await runSlot.get()).items).some((i) => i.company === 'Done'), 'jobs already applied to are left alone')

  // Continue: the user answered the salary question; the job finishes on its open tab.
  script.j3 = ['BLOCKED', 'SUBMIT_REFUSED']
  const openedBefore = opened.length
  await runner.continueJob(beta!)
  await until(async () => (await item('Beta'))?.state === 'ready')
  const betaAfter = await item('Beta')
  expect(betaAfter?.state === 'ready' && !betaAfter.retry, 'Continue finishes a paused job')
  expect(opened.length === openedBefore, 'without reloading its page (what you typed is kept)')

  // Skip: you go on without it; with no jobs left, the run ends.
  await runWorker.setRunItem({ ...betaAfter!, state: 'skipped', reason: 'Skipped by you.' })
  await until(async () => (await runSlot.get()).mode === 'idle')
  const done = await runSlot.get()
  expect(done.mode === 'idle' && /no more Ready jobs/.test(done.status), 'after Skip it goes on, and ends when the list is done')

  // Stop ends a run that is waiting.
  await runSlot.clear()
  jobs.splice(0, jobs.length, { id: 'wa', rowNumber: 2, status: 'READY', jobLink: 'https://jobs.lever.co/a/1', company: 'A', position: 'Dev' })
  script.wa = ['SUBMIT_REFUSED']
  await runner.startRunner()
  await until(async () => (await item('A'))?.state === 'ready')
  await runner.stopRunner()
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect((await runSlot.get()).mode === 'idle', 'Stop ends the run')
}

console.log('\n--- API key mode (Gemini) ---------------------------------------\n')

{
  const { preferencesSlot, masterResumeSlot } = await import('../extension/src/storage/settings.ts')
  const { profileSlot } = await import('../extension/src/storage/applicant-profile.ts')
  const { setApiKey } = await import('../extension/src/storage/credentials.ts')
  const { getProviderFor } = await import('../extension/src/ai/index.ts')
  const runner = await import('../extension/src/sidepanel/lib/runner.ts')
  const { answerInChat } = await import('../extension/src/sidepanel/lib/batch-answers.ts')

  await preferencesSlot.set({ ...(await preferencesSlot.get()), aiMode: 'api', aiProviderId: 'gemini-api', tailorVia: 'chatgpt-project' } as never)
  let prefs = await preferencesSlot.get()
  expect((await getProviderFor('resume')).id === 'gemini-api', 'with a key, tailoring goes to Gemini (not the chat)')
  expect((await getProviderFor('answer:q1')).id === 'gemini-api', 'and so do written answers')

  let problems = runner.runSetupProblems(prefs, await runner.runSetup(prefs))
  expect(problems.some((p) => /Gemini API key/.test(p)) && problems.some((p) => /master resume/.test(p)), `no key, no resume: Autopilot says what to add (${problems.length})`)

  await setApiKey('gemini', 'test-key', true)
  await masterResumeSlot.set({
    fileName: 'Daniel Garcia.docx',
    mimeType: 'text/plain',
    sizeBytes: 100,
    uploadedAt: 1,
    text: 'Daniel Garcia\nSenior Engineer at Acme 2019-2024. Built payment services in Go and React.',
    textIsApproximate: false,
    format: 'text',
  } as never)
  const profile = await profileSlot.get()
  await profileSlot.set({ ...profile, personal: { ...profile.personal, fullName: 'Daniel Garcia', email: 'dan@example.com', city: 'Austin', country: 'USA' } })
  prefs = await preferencesSlot.get()
  problems = runner.runSetupProblems(prefs, await runner.runSetup(prefs))
  expect(problems.length === 0, 'key + resume saved: Autopilot is ready to start (no chat links needed)')

  let prompt = ''
  let usedKey = ''
  g.fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) throw new Error(`unexpected fetch ${url}`)
    usedKey = init.headers['x-goog-api-key'] ?? ''
    prompt = JSON.parse(init.body).contents[0].parts[0].text
    const text = '[1] I built payment services in Go at Acme, so your billing work is familiar ground.\n\n[2] [ADD: your expected salary]'
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })
  }
  const typed: string[] = []
  handlers['page/answerField'] = (p: { value: string }) => {
    typed.push(p.value)
    return {}
  }
  let saved: Record<string, { text: string; warnings: unknown[] }> = {}
  const session = {
    id: 'api-1',
    company: 'Acme',
    position: 'Engineer',
    jobInfo: { title: 'Engineer', company: 'Acme', location: '', description: 'We build billing in Go.', source: 'page', confidence: 0.9, extractedAt: 1 },
  } as never
  const fields = [
    { id: 'q1', label: 'Why are you a fit? *', type: 'textarea', required: true, category: 'AI_GENERATED' },
    { id: 'q2', label: 'Expected salary', type: 'text', required: true, category: 'AI_GENERATED' },
  ] as never
  const outcome = await answerInChat(session, prefs, fields, async (patch) => {
    saved = patch.answers as never
  })

  expect(usedKey === 'test-key', 'the saved key is sent to Gemini')
  expect(/We build billing in Go\./.test(prompt) && /payment services in Go/.test(prompt), 'the request carries the job and your resume (the model does not know you otherwise)')
  expect(/\[1\] Why are you a fit\?/.test(prompt) && /\[2\] Expected salary/.test(prompt), 'both questions numbered in one request')
  expect(!/dan@example\.com/.test(prompt), 'your email is hidden from Google')
  expect(typed.length === 1 && /payment services in Go/.test(typed[0]!), 'the grounded answer is typed into the form')
  expect(outcome.needsFact.length === 1 && outcome.needsFact[0] === 'Expected salary', 'an answer with an [ADD: ...] gap is NOT typed - it needs a fact from you')
  expect(Boolean(saved.q2) && Array.isArray(saved.q1?.warnings), 'both drafts are kept on the application, fact-checked')

  // In a run, that gap pauses the job instead of sending a half-written answer.
  const { sessionsSlot } = await import('../extension/src/storage/sessions.ts')
  const runWorker = await import('../extension/src/background/run.ts')
  await runSlot.clear()
  const job = { id: 'api-job', rowNumber: 2, status: 'READY', jobLink: 'https://jobs.ashbyhq.com/acme/9', company: 'Acme', position: 'Engineer' }
  handlers['source/queue'] = () => ({ jobs: [job], counts: {}, fetchedAt: Date.now() })
  handlers['job/open'] = async () => {
    const s = {
      ...(session as object),
      id: 's-api',
      sheetRow: 2,
      spreadsheetId: 'csv',
      sheetName: 'jobs.csv',
      jobUrl: job.jobLink,
      currentStep: 1,
      totalStepsSeen: 1,
      completedFields: {},
      unansweredFields: [],
      status: 'APPLYING',
      resume: { approved: true, edits: [], warnings: [], changeNotes: [] },
      lastReport: { url: 'https://jobs.ashbyhq.com/acme/9/application', ask: (fields as unknown as object[]).map((field) => ({ field })), skipped: [], fields },
      createdAt: 1,
      updatedAt: 1,
    }
    await sessionsSlot.update((all) => ({ ...all, 's-api': s as never }))
    return s
  }
  handlers['page/next'] = () => ({ outcome: 'SUBMIT_REFUSED', message: '', fromStep: 1, toStep: 1, errors: [] })
  handlers['session/updateWriting'] = () => null
  typed.length = 0
  await runner.startRunner()
  for (let i = 0; i < 120 && Object.values((await runSlot.get()).items)[0]?.state !== 'needs-help'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await runner.stopRunner()
  const item = Object.values((await runSlot.get()).items)[0]
  expect(item?.state === 'needs-help' && /Expected salary/.test(item.reason ?? ''), `in a run, it pauses that job and names the question (${item?.state}: ${item?.reason})`)
  expect(!sent.some((m) => m.type === 'page/next' && (m.payload as { sessionId?: string }).sessionId === 's-api'), 'and does not move on to submit')
  void runWorker
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All run checks passed.\n')
process.exit(0)
