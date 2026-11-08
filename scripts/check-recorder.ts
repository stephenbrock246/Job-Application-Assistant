/**
 * Black-box recorder check.
 *
 *   npm run check:recorder
 *
 * 1. Page copy: typed values are kept, passwords masked, scripts dropped, shadow
 *    DOM written out, and the live page is left untouched.
 * 2. Recorder: timeline, an incident with screenshot + page copy, repeats counted
 *    not re-captured, no screenshot of a hidden tab, the incident limit, clearing.
 * 3. Report: the .zip has the summary, timeline and one folder per problem.
 */

import { JSDOM } from 'jsdom'
import { unzipSync, zipSync, strFromU8 } from 'fflate'

const dom = new JSDOM('<!doctype html><html><head><title>Apply</title></head><body></body></html>', {
  url: 'https://jobs.ashbyhq.com/acme/123/application',
})
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.location = dom.window.location
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Element', 'Node']) {
  g[name] = (dom.window as unknown as Record<string, unknown>)[name]
}

// chrome.* - storage plus just enough tabs/windows for the recorder.
const store = new Map<string, unknown>()
const keys = (k: string | string[]) => (Array.isArray(k) ? k : [k])
let tabActive = true
let snapshotCalls = 0
const fakeSnapshot = {
  url: 'https://jobs.ashbyhq.com/acme/123/application',
  title: 'Apply',
  html: '<html>copy</html>',
  truncated: false,
  fields: [{ id: 'f1', label: 'Country', type: 'select', required: true, value: '' }],
  adapter: 'generic',
  capturedAt: 1,
}
g.chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) =>
        Object.fromEntries(keys(k).filter((key) => store.has(key)).map((key) => [key, structuredClone(store.get(key))])),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value))
      },
      remove: async (k: string | string[]) => keys(k).forEach((key) => store.delete(key)),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
  tabs: {
    get: async (id: number) => ({ id, active: tabActive, windowId: 7 }),
    captureVisibleTab: async () => 'data:image/jpeg;base64,' + Buffer.from('JPEGBYTES').toString('base64'),
    sendMessage: async (_id: number, message: { type: string }) => {
      if (message.type === 'content/snapshot') {
        snapshotCalls += 1
        return { ok: true, data: fakeSnapshot }
      }
      return { ok: false, error: 'unexpected' }
    },
  },
  windows: { get: async () => ({ id: 7, state: 'normal' }) },
}

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

console.log('\n--- Page copy ----------------------------------------------------\n')

{
  const { pageHtml, SNAPSHOT_MAX_CHARS } = await import('../extension/src/content/diagnostics/snapshot.ts')
  const document = dom.window.document
  document.body.innerHTML = `
    <form>
      <input id="name" type="text">
      <input id="pw" type="password">
      <input id="agree" type="checkbox">
      <select id="country"><option>Canada</option><option>United States</option></select>
      <textarea id="why"></textarea>
      <div id="host"></div>
    </form>
    <script>window.evil = 1</script>`
  ;(document.getElementById('name') as HTMLInputElement).value = 'Daniel Garcia'
  ;(document.getElementById('pw') as HTMLInputElement).value = 'hunter2'
  ;(document.getElementById('agree') as HTMLInputElement).checked = true
  ;(document.getElementById('country') as HTMLSelectElement).selectedIndex = 1
  ;(document.getElementById('why') as HTMLTextAreaElement).value = 'Because I like it.'
  const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' })
  shadow.innerHTML = '<label>Inside shadow <input></label>'

  const { html, truncated } = pageHtml()
  expect(html.includes('value="Daniel Garcia"'), 'a typed text value is in the copy')
  expect(!html.includes('hunter2') && html.includes('value="********"'), 'a password is masked')
  expect(/id="agree"[^>]*checked/.test(html), 'a ticked checkbox stays ticked')
  expect(/<option selected="">United States<\/option>/.test(html), 'the chosen option is selected')
  expect(html.includes('Because I like it.</textarea>'), 'textarea text is kept')
  expect(!html.includes('window.evil'), 'scripts are dropped')
  expect(html.includes('<template shadowrootmode="open"><label>Inside shadow'), 'shadow DOM is written out')
  expect(html.includes('<base href="https://jobs.ashbyhq.com/acme/123/application">'), 'a base link lets the copy load the site styles')
  expect(!truncated, 'a normal page is not cut')
  expect(!document.getElementById('name')!.hasAttribute('value'), 'the live page is not modified')

  document.body.innerHTML = `<p>${'x'.repeat(SNAPSHOT_MAX_CHARS + 10)}</p>`
  const big = pageHtml()
  expect(big.truncated && big.html.length < SNAPSHOT_MAX_CHARS + 200, 'a huge page is cut, and says so')
}

console.log('\n--- Recorder -----------------------------------------------------\n')

const recorder = await import('../extension/src/background/recorder.ts')
const diagnostics = await import('../extension/src/storage/diagnostics.ts')
const { sessionsSlot } = await import('../extension/src/storage/sessions.ts')

await sessionsSlot.set({
  s1: {
    id: 's1',
    sheetRow: 4,
    spreadsheetId: 'csv',
    sheetName: 'jobs.csv',
    jobUrl: 'https://jobs.ashbyhq.com/acme/123',
    company: 'Acme',
    position: 'Senior Engineer',
    currentStep: 1,
    totalStepsSeen: 1,
    completedFields: {},
    unansweredFields: [],
    status: 'APPLYING',
    tabId: 42,
    coverLetter: { text: 'A very long private letter', warnings: [], generatedAt: 1, approved: true },
    createdAt: 1,
    updatedAt: 1,
  },
} as never)

{
  recorder.log('info', 'job-opened', 'Acme - Senior Engineer', { sessionId: 's1' })
  recorder.log('info', 'other-job', 'something on another job', { sessionId: 's2' })
  await recorder.flushLog()
  expect((await diagnostics.flightLogSlot.get()).length === 2, 'timeline events are stored')

  const id = await recorder.recordIncident({ kind: 'fill-rejected', message: 'Country not kept', origin: 'pass:autofill', sessionId: 's1', data: { tried: 'USA' } })
  const [incident] = await diagnostics.incidentsSlot.get()
  const detail = await diagnostics.getIncidentDetail(id!)
  expect(Boolean(id) && incident?.id === id, 'an incident is recorded')
  expect(incident?.company === 'Acme' && incident.url === fakeSnapshot.url && incident.adapter === 'generic', 'it knows the job, page and adapter')
  expect(incident?.hasScreenshot === true && detail?.screenshot?.startsWith('data:image/jpeg') === true, 'with a screenshot of the job tab')
  expect(detail?.snapshot?.html === '<html>copy</html>' && detail.snapshot.fields.length === 1, 'and a copy of the page with its fields')
  const steps = detail?.timeline.map((e) => e.kind) ?? []
  expect(steps.includes('job-opened') && steps.includes('fill-rejected') && !steps.includes('other-job'), 'its timeline holds this job\'s steps only')
  const session = detail?.session as { coverLetter?: { text?: string; characters?: number } }
  expect(session?.coverLetter?.text === undefined && session?.coverLetter?.characters === 26, 'long private texts are left out of the session copy')

  const again = await recorder.recordIncident({ kind: 'fill-rejected', message: 'Country not kept', origin: 'pass:autofill', sessionId: 's1' })
  const list = await diagnostics.incidentsSlot.get()
  expect(again === id && list.length === 1 && list[0]?.count === 2, 'a repeat is counted, not recorded twice')
  expect(snapshotCalls === 1, 'a repeat is not captured again')

  const [a, b] = await Promise.all([
    recorder.recordIncident({ kind: 'next-no-change', message: 'Stuck', origin: 'page/next', sessionId: 's1' }),
    recorder.recordIncident({ kind: 'next-no-change', message: 'Stuck', origin: 'page/next', sessionId: 's1' }),
  ])
  const stuck = (await diagnostics.incidentsSlot.get()).filter((i) => i.kind === 'next-no-change')
  expect(a === b && stuck.length === 1, 'two at the same moment still make one incident')
  expect(stuck[0]?.count === 2, 'and the second one is counted on it')

  const manual1 = await recorder.recordIncident({ kind: 'user-report', message: 'Wrong salary', origin: 'panel', manual: true, sessionId: 's1' })
  const manual2 = await recorder.recordIncident({ kind: 'user-report', message: 'Wrong salary', origin: 'panel', manual: true, sessionId: 's1' })
  expect(manual1 !== manual2, 'each "Report a problem" press is its own report')

  tabActive = false
  const hidden = await recorder.recordIncident({ kind: 'action-failed', message: 'hidden tab', origin: 'page/scan', sessionId: 's1' })
  const hiddenSummary = (await diagnostics.incidentsSlot.get()).find((i) => i.id === hidden)
  const hiddenDetail = await diagnostics.getIncidentDetail(hidden!)
  expect(hiddenSummary?.hasScreenshot === false && !hiddenDetail?.screenshot, 'no screenshot when the job tab is not the visible one')
  expect(/not the visible tab/.test(hiddenSummary?.screenshotNote ?? ''), 'and the report says why')
  tabActive = true

  const noJob = await recorder.recordIncident({ kind: 'panel-error', message: 'x is undefined', origin: 'panel', capture: false })
  expect(Boolean(noJob) && !(await diagnostics.getIncidentDetail(noJob!))?.screenshot, 'a failure without a job is recorded without a capture')

  const first = (await diagnostics.incidentsSlot.get())[0]!.id
  for (let i = 0; i < diagnostics.INCIDENT_LIMIT; i += 1) {
    await recorder.recordIncident({ kind: 'action-failed', message: `failure ${i}`, origin: 'page/next', capture: false })
  }
  const capped = await diagnostics.incidentsSlot.get()
  expect(capped.length === diagnostics.INCIDENT_LIMIT, `only the newest ${diagnostics.INCIDENT_LIMIT} incidents are kept`)
  expect(!capped.some((i) => i.id === first) && (await diagnostics.getIncidentDetail(first)) === null, 'the oldest is deleted with its screenshot')

  // Storage failing must not break the caller.
  const realSet = (g.chrome as { storage: { local: { set: unknown } } }).storage.local.set
  ;(g.chrome as { storage: { local: { set: unknown } } }).storage.local.set = async () => {
    throw new Error('quota')
  }
  const broken = await recorder.recordIncident({ kind: 'x', message: 'storage down', origin: 'test', capture: false })
  expect(broken === null, 'when storage fails, recording gives up quietly')
  ;(g.chrome as { storage: { local: { set: unknown } } }).storage.local.set = realSet
}

console.log('\n--- Report -------------------------------------------------------\n')

{
  const { buildReportFiles } = await import('../extension/src/sidepanel/lib/problem-report.ts')
  const before = await diagnostics.incidentsSlot.get()
  await recorder.clearDiagnostics()
  expect((await diagnostics.incidentsSlot.get()).length === 0 && (await diagnostics.flightLogSlot.get()).length === 0, 'Clear empties the problems and the timeline')
  expect((await diagnostics.getIncidentDetail(before[0]!.id)) === null, 'Clear deletes the stored screenshots and page copies')

  // A fresh incident on the Acme job, to check a complete problem folder.
  const id = await recorder.recordIncident({ kind: 'fill-rejected', message: 'Country not kept', origin: 'pass:autofill', sessionId: 's1' })
  const all = await diagnostics.incidentsSlot.get()
  const detailMap = new Map([[id!, (await diagnostics.getIncidentDetail(id!))!]])
  const files = buildReportFiles({
    incidents: all,
    details: detailMap,
    events: await diagnostics.flightLogSlot.get(),
    version: '0.1.0',
    userAgent: 'test',
    generatedAt: Date.now(),
  })
  const unzipped = unzipSync(zipSync(files))
  const paths = Object.keys(unzipped)
  const folder = 'problems/01_acme_fill-rejected'
  expect(['README.txt', 'summary.txt', 'timeline.txt', 'timeline.json'].every((p) => paths.includes(p)), 'README, summary and timeline are in the zip')
  expect(
    [`${folder}/problem.json`, `${folder}/screenshot.jpg`, `${folder}/page.html`, `${folder}/fields.json`].every((p) => paths.includes(p)),
    'one folder per problem with screenshot, page copy and fields',
  )
  expect(strFromU8(unzipped[`${folder}/screenshot.jpg`]!) === 'JPEGBYTES', 'the screenshot is the real image bytes')
  const summaryText = strFromU8(unzipped['summary.txt']!)
  expect(/Acme - Senior Engineer/.test(summaryText) && /Country not kept/.test(summaryText), 'the summary names the job and the problem')
  expect(/PRIVATE/.test(strFromU8(unzipped['README.txt']!)), 'the README warns that it holds personal details')
  const problem = JSON.parse(strFromU8(unzipped[`${folder}/problem.json`]!))
  expect(Array.isArray(problem.stepsBefore) && problem.stepsBefore.some((line: string) => line.includes('fill-rejected')), 'problem.json lists the steps before it')
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All recorder checks passed.\n')
