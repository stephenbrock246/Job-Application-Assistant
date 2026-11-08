/**
 * Multi-page navigation check.
 *
 * Runs the real page-comparison, step-tracking, Next-click and change-detection
 * code against a small single-page-app application form in jsdom:
 *
 *   npm run check:navigation
 *
 * It asserts the phase 4 contract: filling a page is not navigating it, a click is
 * not progress until the page visibly changes, a refused page is reported as
 * refused, Back is recognised as Back, and a final submit is never clicked.
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  url: 'https://jobs.example.com/apply/42',
})

const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.location = dom.window.location
g.HTMLElement = dom.window.HTMLElement
g.HTMLInputElement = dom.window.HTMLInputElement
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
g.HTMLSelectElement = dom.window.HTMLSelectElement
g.HTMLLabelElement = dom.window.HTMLLabelElement
g.Element = dom.window.Element
g.Event = dom.window.Event
g.InputEvent = dom.window.InputEvent
g.MutationObserver = dom.window.MutationObserver
g.CSS = dom.window.CSS
g.NodeFilter = dom.window.NodeFilter
g.MouseEvent = dom.window.MouseEvent
g.KeyboardEvent = dom.window.KeyboardEvent
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)

// jsdom does no layout. Give every rendered element a box, and none to hidden ones.
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const el = this as HTMLElement
  const hidden =
    el.getAttribute?.('type') === 'hidden' ||
    el.style?.display === 'none' ||
    Boolean(el.closest?.('[hidden]'))
  const size = hidden ? 0 : 20
  return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

g.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

const { comparePages } = await import('../extension/src/shared/utils/page-compare.ts')
const { trackStep } = await import('../extension/src/navigation/step-tracker.ts')
const { capturePage } = await import('../extension/src/content/navigation/page-state.ts')
const { awaitChange, startWatching, stopWatching } = await import(
  '../extension/src/content/navigation/page-watcher.ts'
)
const { clickNext, findNextControl } = await import('../extension/src/content/navigation/next-button.ts')

const document = dom.window.document
const app = document.getElementById('app')!

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// A three-step SPA: personal -> experience -> review. The URL never changes.
// ---------------------------------------------------------------------------

let submitted = false

const PAGES: Record<number, string> = {
  1: `
    <form>
      <h2>Personal information</h2>
      <label for="name">Full name *</label><input id="name" name="name" required>
      <label for="email">Email *</label><input id="email" name="email" type="email" required>
      <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
      <div id="sponsor-wrap" hidden>
        <label for="sponsor">Sponsorship details</label><input id="sponsor" name="sponsor">
      </div>
      <p class="error-message" id="err" hidden></p>
      <button type="button" id="next">Next</button>
    </form>`,
  2: `
    <form>
      <h2>Experience</h2>
      <label for="title">Current title *</label><input id="title" name="title" required>
      <label for="years">Years of experience</label><input id="years" name="years">
      <label for="why">Why this role?</label><textarea id="why" name="why"></textarea>
      <button type="button" id="back">Back</button>
      <button type="button" id="next">Continue</button>
    </form>`,
  3: `
    <form>
      <h2>Review your application</h2>
      <p>Please check everything before submitting.</p>
      <button type="button" id="back">Back</button>
      <button type="button" id="submit">Submit application</button>
    </form>`,
}

function render(step: number) {
  app.innerHTML = PAGES[step]!
  const next = document.getElementById('next')
  next?.addEventListener('click', () => onNext(step))
  document.getElementById('back')?.addEventListener('click', () => render(step - 1))
  document.getElementById('submit')?.addEventListener('click', () => {
    submitted = true
  })
}

/** Like a real app: validate, show a spinner, then swap the step in asynchronously. */
function onNext(step: number) {
  const required = Array.from(app.querySelectorAll<HTMLInputElement>('input[required]'))
  const empty = required.filter((input) => !input.value.trim())
  if (empty.length) {
    const err = document.getElementById('err')
    if (err) {
      err.hidden = false
      err.textContent = 'Please complete all required fields.'
    }
    for (const input of empty) input.setAttribute('aria-invalid', 'true')
    return
  }

  const spinner = document.createElement('div')
  spinner.className = 'spinner'
  spinner.setAttribute('aria-busy', 'true')
  document.body.appendChild(spinner)
  setTimeout(() => {
    spinner.remove()
    render(step + 1)
  }, 400)
}

function type(id: string, value: string) {
  const input = document.getElementById(id) as HTMLInputElement
  input.value = value
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

// ---------------------------------------------------------------------------

console.log('\n--- Page identity ---------------------------------------------\n')

render(1)
const page1 = capturePage()
expect(page1.fieldKeys.length === 3, `step 1 has 3 visible questions (got ${page1.fieldKeys.length})`)
expect(page1.heading.includes('Personal information'), `step heading detected ("${page1.heading}")`)

type('name', 'John Doe')
type('email', 'john@example.com')
expect(
  comparePages(page1, capturePage()) === 'same',
  'filling fields does not count as a page change',
)

document.getElementById('sponsor-wrap')!.hidden = false
const revealed = capturePage()
expect(
  comparePages(page1, revealed) === 'modified',
  'a conditional question appearing is "modified", not a new page',
)
document.getElementById('sponsor-wrap')!.hidden = true

const fakeRepeat = { ...page1, heading: 'Work experience 2' }
expect(
  comparePages(page1, fakeRepeat) === 'new-page',
  'identical questions under a new heading are a new page (repeated section)',
)

console.log('\n--- Step tracking ---------------------------------------------\n')

const posting = { url: 'https://jobs.example.com/42', heading: 'Engineer', fieldKeys: ['email:newsletter'], takenAt: 0 }
const blank = { currentStep: 1, totalStepsSeen: 1, steps: [] as never[] }
expect(
  trackStep(blank, posting, { totalFields: 1, completedFields: 0 }).transition === 'none',
  'a job posting with a single newsletter box is not step 1',
)

const s1 = trackStep(blank, page1, { totalFields: 3, completedFields: 2 })
expect(s1.transition === 'first' && s1.currentStep === 1, 'first form page becomes step 1')

console.log('\n--- Next: refused by validation -------------------------------\n')

type('name', '')
let base = capturePage()
let click = clickNext()
expect(click.clicked && click.label === 'Next', `clicked the "Next" control (${JSON.stringify(click)})`)
let result = await awaitChange(base, 5_000)
expect(result.change === 'same', `page stayed put when required fields were empty (${result.change})`)
expect(result.errors.length > 0 && !result.timedOut, `validation errors reported, not a timeout (${result.errors.length} errors)`)

console.log('\n--- Next: advances (async swap behind a spinner) --------------\n')

type('name', 'John Doe')
base = capturePage()
click = clickNext()
expect(click.clicked, 'clicked Next with the page complete')
result = await awaitChange(base, 5_000)
expect(result.change === 'new-page', `detected the new step without any URL change (${result.change})`)
expect(result.page.heading.includes('Experience'), `landed on "Experience" ("${result.page.heading}")`)

const s2 = trackStep(
  { ...blank, currentPage: s1.currentPage!, steps: s1.steps, currentStep: 1, totalStepsSeen: 1 },
  result.page,
  { totalFields: 3, completedFields: 0 },
)
expect(s2.transition === 'advanced' && s2.currentStep === 2, `step 2 recorded (${s2.transition}, ${s2.currentStep})`)
expect(findNextControl()?.label === 'Continue', 'found "Continue" as the next control')

console.log('\n--- Back is recognised as Back --------------------------------\n')

document.getElementById('back')!.dispatchEvent(new dom.window.Event('click'))
await sleep(50)
const backPage = capturePage()
const s3 = trackStep(
  { currentPage: s2.currentPage!, steps: s2.steps, currentStep: 2, totalStepsSeen: 2 },
  backPage,
  { totalFields: 3, completedFields: 0 },
)
expect(s3.transition === 'returned' && s3.currentStep === 1, `going back returns to step 1 (${s3.transition}, ${s3.currentStep})`)
expect(s3.totalStepsSeen === 2, 'going back does not inflate the step count')

console.log('\n--- Passive watcher follows manual navigation -----------------\n')

const seen: string[] = []
startWatching((change) => seen.push(change))
render(2)
await sleep(1_200)
stopWatching()
expect(seen.includes('new-page'), `watcher reported a hand-made page change (${seen.join(', ') || 'nothing'})`)

console.log('\n--- Final submit is never clicked -----------------------------\n')

render(3)
click = clickNext()
expect(!click.clicked && click.reason === 'SUBMIT_REFUSED', `refused the final submit (${JSON.stringify(click)})`)
await sleep(100)
expect(!submitted, 'the Submit button was not pressed')

console.log('\n--- Labels from your JobDiva form -------------------------------\n')

const { scanFields } = await import('../extension/src/content/scanner/form-scanner.ts')
app.innerHTML = `
  <form>
    <div><label>Phone</label>
      <div class="phone-group">
        <select name="country"><option>US</option><option>ES</option></select>
        <span>+1</span>
        <input type="tel" name="phone">
      </div>
    </div>
    <div class="question">
      <div class="title">Upload Your Resume *</div>
      <div class="dropzone">
        <p>Drag and drop a fileor browse your device</p>
        <input type="file" name="resumeFile" style="display:none">
      </div>
    </div>
  </form>`
const labelled = scanFields()
const phoneField = labelled.find((f) => f.type === 'tel')
const uploadField = labelled.find((f) => f.type === 'file')
expect(phoneField?.label === 'Phone', `phone box labelled "Phone", not its "+1" prefix or the "US" dropdown (${phoneField?.label})`)
expect(Boolean(uploadField), 'a hidden file input inside a visible drop zone is found')
expect(uploadField?.label === 'Upload Your Resume *', `upload labelled by its heading, not the drop-zone text (${uploadField?.label})`)
expect(uploadField?.required === true, 'the * on the heading makes the upload required')

console.log('\n--- Every field is listed, especially the * ones ---------------\n')

app.innerHTML = `
  <form>
    <p class="note">* indicates a required field</p>
    <div><label for="fn">First Name *</label><input id="fn" name="first"></div>
    <div>
      <div id="exp-label">Years of experience *</div>
      <div role="combobox" aria-labelledby="exp-label" aria-haspopup="listbox" class="custom-select">Select...</div>
    </div>
    <div>
      <div id="reloc-label">Willing to relocate? <span>*</span></div>
      <div role="radiogroup" aria-labelledby="reloc-label">
        <div role="radio" aria-checked="false">Yes</div>
        <div role="radio" aria-checked="true">No</div>
      </div>
    </div>
    <div class="question">
      <span>Earliest start date</span><span>*</span>
      <div class="fancy-date-widget"><div class="cell">Pick</div></div>
    </div>
    <div>
      <label for="city">City</label>
      <input id="city" name="city" role="combobox" aria-autocomplete="list">
    </div>
  </form>`
const everything = scanFields()
const byLabel = (needle: string) => everything.find((f) => f.label.toLowerCase().includes(needle))
const experience = byLabel('years of experience')
const relocate = byLabel('relocate')
const startDate = byLabel('earliest start date')

expect(Boolean(experience?.custom) && experience?.required === true && experience.value === '', 'a site-built dropdown is listed, required, and its "Select..." is not taken as an answer')
expect(relocate?.custom === true && relocate.value === 'No' && relocate.options?.join() === 'Yes,No', 'a site-built radio group is listed with its current choice')
expect(Boolean(startDate?.valueUnknown) && startDate?.required === true, 'a * question whose control cannot be read is still listed ("check on the page")')
expect(everything.filter((f) => f.label.toLowerCase().includes('first name')).length === 1, 'a normal * field is listed once, not duplicated by the * sweep')
expect(!everything.some((f) => /indicates/i.test(f.label)), 'the "* indicates a required field" note is not mistaken for a question')
expect(byLabel('city')?.widget === 'typeahead', 'a type-and-pick box is recognised as one (filled by picking a suggestion, not by typing alone)')

const { planAutofill } = await import('../extension/src/autofill/planner.ts')
const { EMPTY_PROFILE } = await import('../extension/src/shared/constants/defaults.ts')
const cityPlan = planAutofill(
  [{ ...byLabel('city')!, canonicalField: 'city', category: 'GLOBAL', confidence: 0.99 }],
  { ...EMPTY_PROFILE, personal: { ...EMPTY_PROFILE.personal, city: 'Madrid' } },
  [],
).plans[0]!
expect(cityPlan.decision === 'fill' && cityPlan.value === 'Madrid', 'a widget the extension can operate is filled from your saved answer')
const unreadable = planAutofill([{ ...startDate! }], EMPTY_PROFILE, []).plans[0]!
expect(unreadable.decision === 'ask' && Boolean(unreadable.reason?.includes('check it on the page')), 'an unreadable * question is never filled - it is listed for you to check')

console.log('\n--- Ashby-style form: buttons, typeahead, CSS-marked required ---\n')

app.innerHTML = `
  <form>
    <div class="field">
      <label class="question-title _required_x1" for="loc">Where are you located?</label>
      <input id="loc" placeholder="Start typing..." role="combobox" aria-autocomplete="list" aria-controls="loc-list">
      <div id="loc-list" role="listbox"></div>
    </div>
    <div class="field">
      <label class="question-title _required_x1">Will you now or in the future require employment visa sponsorship to work in the United States?</label>
      <div class="_yesno_k2"><button type="button" class="_option_k2">Yes</button><button type="button" class="_option_k2">No</button></div>
    </div>
    <fieldset><legend>Gender</legend>
      <label><input type="radio" name="gender" value="m">Male</label>
      <label><input type="radio" name="gender" value="f">Female</label>
      <label><input type="radio" name="gender" value="d">Decline to self-identify</label>
    </fieldset>
    <fieldset><legend>Veteran Status</legend>
      <label><input type="radio" name="vet" value="a">I identify as one or more of the classifications of protected veteran</label>
      <label><input type="radio" name="vet" value="b">I am not a protected veteran</label>
      <label><input type="radio" name="vet" value="c">I decline to self-identify for protected veteran status</label>
    </fieldset>
  </form>`

// The site's own behaviour: option buttons toggle an opaque CSS-module class;
// the location box suggests places as you type and takes the one you click.
for (const button of app.querySelectorAll<HTMLButtonElement>('._yesno_k2 button')) {
  button.addEventListener('click', () => {
    for (const other of app.querySelectorAll('._yesno_k2 button')) other.classList.remove('_active_k2')
    button.classList.add('_active_k2')
  })
}
const locationInput = document.getElementById('loc') as HTMLInputElement
const locationList = document.getElementById('loc-list')!
locationInput.addEventListener('input', () => {
  locationList.innerHTML = ''
  const typed = locationInput.value.toLowerCase()
  if (!typed) return
  for (const place of ['Riga, Latvia', 'Rīga District, Latvia', 'Rigby, Idaho, US']) {
    if (!place.toLowerCase().startsWith(typed.slice(0, 3))) continue
    const option = document.createElement('div')
    option.setAttribute('role', 'option')
    option.textContent = place
    option.addEventListener('click', () => {
      locationInput.value = place
      locationList.innerHTML = ''
    })
    locationList.appendChild(option)
  }
})

const { classifyAll } = await import('../extension/src/content/scanner/field-classifier.ts')
const { GenericAdapter } = await import('../extension/src/content/adapters/generic.adapter.ts')
const ashbyFields = classifyAll(scanFields())
const find = (needle: string) => ashbyFields.find((f) => f.label.toLowerCase().includes(needle))
const located = find('where are you located')
const sponsorship = find('sponsorship')

expect(located?.widget === 'typeahead' && located.required === true, `"Where are you located?" found as a required type-and-pick box (${located?.widget}, required ${located?.required})`)
expect(sponsorship?.widget === 'buttons' && sponsorship.required === true && sponsorship.options?.join() === 'Yes,No', 'the Yes / No sponsorship buttons are found as a required question')
expect(located?.canonicalField === 'location' && sponsorship?.canonicalField === 'sponsorshipRequired', 'both are recognised (location, sponsorship)')

const ashbyProfile = {
  ...EMPTY_PROFILE,
  personal: { ...EMPTY_PROFILE.personal, city: 'Riga', country: 'Latvia' },
  workAuthorization: { workAuthorization: 'I am authorized to work in US', sponsorshipRequired: 'No' },
  voluntary: { ...EMPTY_PROFILE.voluntary, gender: 'Decline to self-identify' },
}
const ashbyPlan = planAutofill(ashbyFields, ashbyProfile, [])
const plannedLabels = ashbyPlan.instructions.map((i) => ashbyFields.find((f) => f.id === i.fieldId)?.label.toLowerCase() ?? '')
expect(plannedLabels.some((l) => l.includes('located')) && plannedLabels.some((l) => l.includes('sponsorship')), 'both are planned for filling from your saved answers')
expect(plannedLabels.some((l) => l.startsWith('gender')), 'Gender is answered - only because you set a voluntary answer')
expect(!plannedLabels.some((l) => l.includes('veteran')), 'Veteran status is NOT answered - its voluntary answer is blank')

const ashbyOutcomes = await new GenericAdapter().fillFields(ashbyPlan.instructions)
expect(ashbyOutcomes.every((o) => o.filled), `every fill verified on the page (${ashbyOutcomes.map((o) => `${o.filled ? 'ok' : 'FAIL'}:${o.actualValue ?? o.error}`).join(', ')})`)
expect(locationInput.value === 'Riga, Latvia', `location: typed "Riga", picked the "Riga, Latvia" suggestion (${locationInput.value})`)
expect(app.querySelectorAll('._yesno_k2 button')[1]!.classList.contains('_active_k2'), 'sponsorship: "No" clicked and shown as chosen')
expect((app.querySelector('input[name="gender"][value="d"]') as HTMLInputElement).checked, 'gender: "Decline to self-identify" selected')
expect(![...app.querySelectorAll<HTMLInputElement>('input[name="vet"]')].some((r) => r.checked), 'veteran status left for you')

const rescanned = classifyAll(scanFields())
expect(rescanned.find((f) => f.label.toLowerCase().includes('sponsorship'))?.value === 'No', 'a rescan reads the chosen button back ("No"), so it is not reported as empty')

console.log('\n--- Cancel while waiting for the page ---------------------------\n')

const { cancelWait } = await import('../extension/src/content/navigation/page-watcher.ts')
render(1)
const waitStart = Date.now()
setTimeout(cancelWait, 150)
const cancelledWait = await awaitChange(capturePage(), 10_000)
expect(Boolean(cancelledWait.cancelled) && !cancelledWait.timedOut, 'Cancel ends the wait for a page change')
expect(Date.now() - waitStart < 2_000, `and it ends at once, not at the 10s deadline (${Date.now() - waitStart}ms)`)

console.log('\n--- One application per job (not per row) ---------------------\n')

const { jobUrlKey, sameJobUrl, isDifferentPosting } = await import('../extension/src/shared/utils/job-url.ts')

expect(
  sameJobUrl('https://www.Workable.com/j/ABC123/?utm_source=linkedin#apply', 'https://workable.com/j/ABC123'),
  'same job despite www, case, trailing slash, tracking params and #fragment',
)
expect(
  !sameJobUrl('https://boards.greenhouse.io/acme/jobs?gh_jid=1', 'https://boards.greenhouse.io/acme/jobs?gh_jid=2'),
  'job-identifying query parameters are kept (gh_jid 1 vs 2 are different jobs)',
)
expect(jobUrlKey('https://jobs.lever.co/acme/uuid-1?lever-source=LinkedIn') === 'jobs.lever.co/acme/uuid-1', 'Lever tracking source dropped')

// A small in-memory chrome.storage so the real session store can run.
const memory: Record<string, unknown> = {}
;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in memory ? { [key]: memory[key] } : {}),
      set: async (items: Record<string, unknown>) => void Object.assign(memory, items),
      remove: async (key: string) => void delete memory[key],
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}
const { saveSession, findSessionForJob, findSessionForTab } = await import('../extension/src/storage/sessions.ts')

const sessionBase = {
  spreadsheetId: 'csv',
  sheetName: 'job-list-template.csv',
  company: 'OkWhen',
  position: 'Senior .NET Engineer',
  currentStep: 1,
  totalStepsSeen: 1,
  completedFields: {},
  unansweredFields: [],
  status: 'RESUME_REVIEW' as const,
  createdAt: 1,
  updatedAt: 1,
}
await saveSession({
  ...sessionBase,
  id: 'old',
  sheetRow: 13,
  jobUrl: 'https://apply.workable.com/okwhen/j/AAA/',
  tabId: 7,
  resume: { edits: [], changeNotes: [], warnings: [], promptProfileId: 'p', promptProfileName: 'p', masterFileName: 'm', masterUploadedAt: 1, generatedAt: 1, approved: false },
})

const otherJobSameRow = await findSessionForJob('csv', 'job-list-template.csv', 'https://jobs.ashbyhq.com/junipersquare/BBB')
expect(otherJobSameRow === null, 'a different job on the same row does NOT get the old job\'s session (the bug)')

const movedJob = await findSessionForJob('csv', 'job-list-template.csv', 'https://apply.workable.com/okwhen/j/AAA?utm_source=x')
expect(movedJob?.id === 'old', 'the same job is found by its link, whichever row it is on now')

const otherList = await findSessionForJob('csv', 'another-list.csv', 'https://apply.workable.com/okwhen/j/AAA/')
expect(otherList === null, 'sessions from another job list are not reused')

expect((await findSessionForTab(7))?.id === 'old', 'a tab resolves to the application it is working on')

const jd = 'We are hiring a senior backend engineer to build payment APIs in Go with PostgreSQL and Kafka on AWS.'
expect(
  !isDifferentPosting({ url: 'https://x.com/j/1', title: 'Backend Engineer', description: jd }, { url: 'https://x.com/j/1/', title: 'Backend Engineer', description: jd }),
  're-scanning the same posting keeps the tailored resume',
)
expect(
  isDifferentPosting(
    { url: 'https://x.com/j/1', title: 'Backend Engineer', description: jd },
    { url: 'https://y.com/j/9', title: 'Operations Partner', description: 'Juniper Square is the operations partner for GPs in private markets, unifying fund administration.' },
  ),
  'a different posting is detected, so the old resume and cover letter are cleared',
)
expect(
  !isDifferentPosting(
    { title: 'Backend Engineer', description: jd },
    { url: 'https://x.com/j/1?ref=2', title: 'Backend Engineer', description: `${jd} Apply now.` },
  ),
  'the same posting under a different URL (redirect, tracking) is not treated as a new job',
)

console.log('')
if (failures.length) {
  console.error(`${failures.length} navigation check(s) failed.\n`)
  process.exit(1)
}
console.log('All navigation checks passed.\n')
process.exit(0)
