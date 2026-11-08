/**
 * Regression checks for matching and state bugs found in review.
 *
 *   npm run check:fixes
 *
 * Each block is one bug that once shipped: the wrong dropdown option, a label
 * filled with the wrong profile value, a "State" column taken as Status, the CV
 * headline read as a city, dates hidden as phone numbers, and session writes that
 * overwrote each other.
 */

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

// Minimal chrome.storage for the storage modules.
const store: Record<string, unknown> = {}
;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    local: {
      get: async (key: string) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        return key in store ? { [key]: structuredClone(store[key]) } : {}
      },
      set: async (items: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        Object.assign(store, structuredClone(items))
      },
      remove: async (key: string) => void delete store[key],
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
}

console.log('\n--- Dropdown and radio options ------------------------------------\n')
{
  const { bestOption } = await import('../extension/src/content/autofill/fill-element.ts')
  const cases: [string[], string, number | null, string][] = [
    [['Namibia (+264)', 'Nepal (+977)', 'Nigeria (+234)'], 'Nigeria', 2, 'a country starting with N is not "No"'],
    [['Germany', 'Netherlands', 'Norway'], 'Norway', 2, '"Norway" is Norway'],
    [['I do not require sponsorship', 'I will require sponsorship'], 'Yes', 1, '"Yes" is not "I do NOT require..."'],
    [['I do not require sponsorship', 'I will require sponsorship'], 'No', 0, '"No" picks the negative option'],
    [['I am not a protected veteran', 'I am a protected veteran'], 'I am a protected veteran', 1, 'veteran: the affirmative option'],
    [['—', 'United States of America'], 'United States', 1, 'a "—" placeholder never matches'],
    [['Select...', 'Yes', 'No'], 'yes', 1, 'a "Select..." placeholder never matches'],
    [['Woman', 'Male'], 'Man', null, '"Man" does not pick "Woman"'],
    [['N/A', 'No', 'Yes'], 'No', 1, '"N/A" is not "No"'],
    [['Yes, I am authorized to work in the US', 'No'], 'Yes', 0, 'a long yes option'],
  ]
  for (const [options, value, want, label] of cases) expect(bestOption(options, value) === want, label)
}

console.log('\n--- Labels to profile fields --------------------------------------\n')
{
  const { matchCanonicalField } = await import('../extension/src/storage/answers.ts')
  const key = (label: string) => {
    const match = matchCanonicalField(label)
    return match && match.confidence >= 0.7 ? match.key : null
  }
  expect(key('Name') === 'fullName' && key('First name') === 'firstName' && key('Phone number') === 'phone', 'plain labels still match')
  expect(key('Mobile') === 'phone' && key('State') === 'state', 'one-word labels match when they are the whole label')
  expect(key('Company Name') !== 'fullName' && key('Referrer Name') !== 'fullName', '"Company Name" / "Referrer Name" do not get your name')
  expect(key('Do you have experience with mobile development?') === null, 'a question mentioning "mobile" is not the phone field')
  expect(key('Which region are you applying to?') === null, '"Which region..." is not your state')
  expect(key('State your reason for applying') === null, '"State your reason" is not your state')
}

console.log('\n--- Job list columns ----------------------------------------------\n')
{
  const { buildColumnMap } = await import('../extension/src/jobsource/row-parser.ts')
  const map = buildColumnMap(['Date', 'Job Link', 'Company', 'Position', 'City', 'State', 'Status'])
  expect(map.status === 6, `"Status" is the status column, not "State" before it (got ${map.status})`)
  const legacy = buildColumnMap(['Job Link', 'State'])
  expect(legacy.status === 1, 'a list whose only status column is called "State" still works')
}

console.log('\n--- Location from the CV header -----------------------------------\n')
{
  const { extractProfile } = await import('../extension/src/resume/profile-extract.ts')
  const values = Object.fromEntries(
    extractProfile([
      { id: 0, text: 'AGAMYRAT AKMYRADOV\nSenior Software Engineer | Python, Healthcare AI', role: 'body', bold: true, align: 'center' },
      { id: 1, text: 'agamyrat@example.com | +371 2000 0000 | Riga, Latvia', role: 'body', bold: false, align: 'center' },
      { id: 2, text: 'Professional Summary', role: 'heading', bold: true, align: 'left' },
    ] as never).map((s: { name: string; value: string }) => [s.name, s.value]),
  )
  expect(values.city === 'Riga' && values.country === 'Latvia', `the city comes from the contact line, not the headline (${values.city}, ${values.country})`)
}

console.log('\n--- Contact redaction ---------------------------------------------\n')
{
  const { redactContacts } = await import('../extension/src/ai/redact.ts')
  const text = 'Acme Corp\t2019 - 2021\n2018 - 2019 Intern\nCall +40 791 392 970'
  const redacted = redactContacts(text).text
  expect(redacted.includes('2019 - 2021') && redacted.includes('2018 - 2019'), `dates on separate lines are not taken for a phone (${JSON.stringify(redacted)})`)
  expect(!redacted.includes('791 392 970'), 'the real phone number is still hidden')
}

console.log('\n--- Session writes ------------------------------------------------\n')
{
  const { saveSession, patchSession, removeSession, getSession } = await import('../extension/src/storage/sessions.ts')
  const base = { id: 'a', company: 'A', updatedAt: 0 } as never
  await saveSession(base)
  await saveSession({ ...(base as object), id: 'b', company: 'B' } as never)
  // Concurrent patches to one session and to another: every change must survive.
  await Promise.all([
    patchSession('a', { company: 'A2' } as never),
    patchSession('a', { position: 'Engineer' } as never),
    patchSession('b', { position: 'Designer' } as never),
    patchSession('a', { tabId: 7 } as never),
  ])
  const a = (await getSession('a')) as unknown as Record<string, unknown>
  const b = (await getSession('b')) as unknown as Record<string, unknown>
  expect(a.company === 'A2' && a.position === 'Engineer' && a.tabId === 7, `concurrent patches to one session all kept (${JSON.stringify(a)})`)
  expect(b.position === 'Designer' && b.company === 'B', 'a patch to another session at the same time is kept')
  // A patch racing a removal must not bring the session back.
  await Promise.all([removeSession('b'), patchSession('b', { company: 'zombie' } as never)])
  expect((await getSession('b')) === null, 'a removed session stays removed')
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All regression checks passed.\n')
