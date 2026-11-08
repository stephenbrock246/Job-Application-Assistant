/**
 * Scanner / classifier / planner check.
 *
 * Runs the real content-script code against an HTML fixture in jsdom and asserts
 * the behaviour that matters most: that nothing dangerous is ever auto-filled, and
 * that ordinary fields are recognised.
 *
 *   npm run check:scanner
 *
 * This is not a substitute for trying a real job board, but it catches the class of
 * regression where a change to the classifier quietly starts ticking legal
 * checkboxes.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// jsdom must exist as globals before the content modules are imported.
// ---------------------------------------------------------------------------

const html = readFileSync(path.join(here, 'fixtures/acme-application.html'), 'utf-8')
const dom = new JSDOM(html, { url: 'https://boards.acme.com/jobs/1234/apply' })

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
g.CSS = dom.window.CSS
g.NodeFilter = dom.window.NodeFilter
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)

// jsdom does not lay anything out, so every element measures 0x0. Report a real
// box so the scanner's visibility filter behaves as it does in a browser.
dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
  const hidden =
    (this as HTMLElement).getAttribute?.('type') === 'hidden' ||
    (this as HTMLElement).style?.display === 'none'
  const size = hidden ? 0 : 20
  return { width: size, height: size, top: 0, left: 0, right: size, bottom: size, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
}

// chrome.* is not touched by the modules under test, but the import graph reaches
// storage helpers that reference it at module scope in some builds.
g.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

const { scanFields } = await import('../extension/src/content/scanner/form-scanner.ts')
const { classifyAll } = await import('../extension/src/content/scanner/field-classifier.ts')
const { planAutofill } = await import('../extension/src/autofill/planner.ts')
const { findNextControl } = await import('../extension/src/content/navigation/next-button.ts')
const { fillFields } = await import('../extension/src/content/autofill/fill-element.ts')
const { EMPTY_PROFILE } = await import('../extension/src/shared/constants/defaults.ts')

// ---------------------------------------------------------------------------

const profile = {
  ...EMPTY_PROFILE,
  personal: {
    ...EMPTY_PROFILE.personal,
    firstName: 'John',
    lastName: 'Doe',
    fullName: 'John Doe',
    email: 'john.doe@gmail.com',
    phone: '+1 (415) 555-0123',
    city: 'San Francisco',
    state: 'CA',
    linkedin: 'https://linkedin.com/in/johndoe',
  },
  professional: {
    ...EMPTY_PROFILE.professional,
    currentTitle: 'Software Engineer',
    yearsOfExperience: '5 years',
  },
  preferences: {
    ...EMPTY_PROFILE.preferences,
    expectedSalary: '12,000 - 15,000',
    // noticePeriod deliberately left blank - it is the mockup's "needs input" case.
  },
  workAuthorization: {
    workAuthorization: 'I am authorized to work in the U.S.',
    sponsorshipRequired: 'No',
  },
}

const raw = scanFields()
const fields = classifyAll(raw)
const plan = planAutofill(fields, profile, [])

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\nScanned ${fields.length} fields on ${dom.window.location.href}\n`)

const pad = (value: string, width: number) => value.padEnd(width).slice(0, width)
console.log(
  pad('LABEL', 44) + pad('TYPE', 10) + pad('REQ', 5) + pad('CANONICAL', 22) + pad('CAT', 10) + 'CONF',
)
console.log('-'.repeat(104))
for (const field of fields) {
  console.log(
    pad(field.label, 44) +
      pad(field.type, 10) +
      pad(field.required ? 'yes' : '-', 5) +
      pad(field.canonicalField ?? '-', 22) +
      pad((field.category ?? '-').slice(0, 9), 10) +
      (field.confidence ?? 0).toFixed(2),
  )
}

console.log(`\nWould fill (${plan.instructions.length}):`)
for (const instruction of plan.instructions) {
  const field = fields.find((f) => f.id === instruction.fieldId)
  console.log(`  + ${pad(field?.label ?? instruction.fieldId, 42)} = ${instruction.value}`)
}

console.log(`\nWould ask (${plan.ask.length}):`)
for (const item of plan.ask) {
  console.log(`  ? ${pad(item.field.label, 42)} ${item.reason ?? ''}`)
}

console.log(`\nSkipped (${plan.skipped.length}):`)
for (const item of plan.skipped) {
  console.log(`  - ${pad(item.field.label, 42)} ${item.reason ?? ''}`)
}

const next = findNextControl()
console.log(`\nNext control: ${next ? `"${next.label}" (${next.kind})` : 'none found'}`)

// ---------------------------------------------------------------------------
// Apply the plan and verify the values actually landed in the DOM.
// ---------------------------------------------------------------------------

const outcomes = fillFields(plan.instructions)
const afterFill = classifyAll(scanFields())

console.log('\nFill outcomes:')
for (const outcome of outcomes) {
  const mark = outcome.filled ? 'ok  ' : 'FAIL'
  console.log(
    `  ${mark} ${pad(labelOfIn(afterFill, outcome.fieldId), 42)} -> ${outcome.actualValue ?? ''}${
      outcome.error ? `  (${outcome.error})` : ''
    }`,
  )
}

function labelOfIn(list: typeof fields, id: string) {
  return list.find((f) => f.id === id)?.label ?? id
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const failures: string[] = []

function expect(condition: boolean, message: string) {
  if (!condition) failures.push(message)
}

const labelOf = (id: string) => fields.find((f) => f.id === id)?.label ?? id
const filledLabels = plan.instructions.map((i) => labelOf(i.fieldId).toLowerCase())
const askLabels = plan.ask.map((p) => p.field.label.toLowerCase())

// --- Safety: these must never be written to, under any circumstances.
for (const forbidden of ['certify', 'privacy policy', 'gender', 'veteran']) {
  expect(
    !filledLabels.some((label) => label.includes(forbidden)),
    `SAFETY: a field matching "${forbidden}" was scheduled for autofill`,
  )
}

const protectedFields = fields.filter((f) => f.category === 'USER_CONFIRMATION_REQUIRED')
expect(
  protectedFields.length >= 4,
  `expected at least 4 protected fields, found ${protectedFields.length}`,
)

expect(
  !plan.instructions.some((i) => fields.find((f) => f.id === i.fieldId)?.type === 'file'),
  'SAFETY: a file input was scheduled for autofill',
)

// --- Noise rejection.
expect(!fields.some((f) => /search/i.test(f.label)), 'the site search box was scanned as a field')
expect(!fields.some((f) => /csrf/i.test(f.label)), 'a hidden input was scanned as a field')
expect(!fields.some((f) => /internal ref/i.test(f.label)), 'a disabled input was scanned as a field')

// --- Recognition of ordinary fields.
const shouldFill: [string, string][] = [
  ['full name', 'John Doe'],
  ['email', 'john.doe@gmail.com'],
  ['phone', '+1 (415) 555-0123'],
  ['current title', 'Software Engineer'],
  ['expected compensation', '12,000 - 15,000'],
]
for (const [label, value] of shouldFill) {
  const instruction = plan.instructions.find((i) => labelOf(i.fieldId).toLowerCase().includes(label))
  expect(Boolean(instruction), `expected "${label}" to be filled, but it was not`)
  if (instruction) {
    expect(
      instruction.value === value,
      `expected "${label}" to be filled with "${value}", got "${instruction.value}"`,
    )
  }
}

// --- The mockup's headline case: notice period has no saved value, so we ask.
expect(
  askLabels.some((label) => label.includes('notice period')),
  'expected "Notice period" to be asked for, since no value is saved',
)

// --- A prefilled field must be left alone.
expect(
  !filledLabels.some((label) => label.includes('linkedin')),
  'a field the site had already filled was overwritten',
)

// --- The free-text question is a written answer, not a data field.
const why = fields.find((f) => f.label.toLowerCase().includes('why are you interested'))
expect(why?.category === 'AI_GENERATED', `expected the "why" question to be AI_GENERATED, got ${why?.category}`)

// --- Next control detection.
expect(next?.label === 'Next', `expected to find the "Next" button, got ${next?.label ?? 'none'}`)

// --- Every planned fill must actually land in the DOM.
for (const outcome of outcomes) {
  expect(
    outcome.filled,
    `fill failed for "${labelOfIn(afterFill, outcome.fieldId)}": ${outcome.error ?? 'unknown'}`,
  )
}

// --- Option matching resolved to the right entries, not merely "an" entry.
const experienceSelect = dom.window.document.querySelector<HTMLSelectElement>('#experience')
expect(
  experienceSelect?.selectedOptions[0]?.text === '5 years',
  `expected experience select to be "5 years", got "${experienceSelect?.selectedOptions[0]?.text}"`,
)

const workAuthYes = dom.window.document.querySelector<HTMLInputElement>('input[name="work_auth"][value="yes"]')
expect(
  workAuthYes?.checked === true,
  'expected the work authorization radio to resolve "I am authorized to work in the U.S." to Yes',
)

const sponsorshipNo = dom.window.document.querySelector<HTMLInputElement>('input[name="sponsorship"][value="no"]')
expect(sponsorshipNo?.checked === true, 'expected the sponsorship radio to resolve "No" to No')

// --- And the protected controls are still untouched after a full autofill pass.
for (const name of ['certify', 'privacy']) {
  const box = dom.window.document.querySelector<HTMLInputElement>(`input[name="${name}"]`)
  expect(box?.checked === false, `SAFETY: the "${name}" checkbox was ticked by autofill`)
}
for (const id of ['#gender', '#veteran']) {
  const select = dom.window.document.querySelector<HTMLSelectElement>(id)
  expect(select?.value === '', `SAFETY: the ${id} select was answered by autofill`)
}
expect(
  dom.window.document.querySelector<HTMLInputElement>('#linkedin')?.value ===
    'https://linkedin.com/in/prefilled',
  'a prefilled value was overwritten during the fill pass',
)

// --- Web components: inputs inside open shadow roots (SmartRecruiters Easy Apply style).
{
  g.ShadowRoot = dom.window.ShadowRoot
  const { resolve } = await import('../extension/src/content/scanner/locator.ts')
  const doc = dom.window.document
  const section = doc.createElement('section')
  doc.body.appendChild(section)
  const component = (tag: string, inner: string, attrs: Record<string, string> = {}) => {
    const host = doc.createElement(tag)
    for (const [name, value] of Object.entries(attrs)) host.setAttribute(name, value)
    host.attachShadow({ mode: 'open' }).innerHTML = inner
    section.appendChild(host)
    return host
  }
  component('spl-input', '<label for="fn">First name*</label><input id="fn" type="text" required>')
  component('spl-input', '<label for="fn">Last name*</label><input id="fn" type="text" required>')
  component('spl-email', '<input type="email">', { label: 'Confirm your email', required: '' })

  const shadowFields = scanFields().filter((f) => /First name|Last name|Confirm your email/.test(f.label))
  const labels = shadowFields.map((f) => f.label.replace(/\*$/, ''))
  expect(
    JSON.stringify(labels) === JSON.stringify(['First name', 'Last name', 'Confirm your email']),
    `fields inside web components are found with their labels (${labels.join(' | ')})`,
  )
  expect(shadowFields.every((f) => f.required), 'required read inside the component and from its host')
  const last = shadowFields.find((f) => /Last name/.test(f.label))
  const element = last ? resolve(last.id) : null
  expect(Boolean(element) && (element!.getRootNode() as ShadowRoot).host === section.children[1], `a shadow field resolves to its own input (${last?.id})`)
  // The same id still resolves after the scan registry is gone (another scan, a reload of the panel).
  const { resetRegistry } = await import('../extension/src/content/scanner/locator.ts')
  resetRegistry()
  expect(last ? resolve(last.id) === element : false, 'its locator reaches through the shadow root on its own')
  section.remove()
}

console.log('')
if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`)
  console.error(`\n${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log(`All checks passed (${fields.length} fields scanned).\n`)
