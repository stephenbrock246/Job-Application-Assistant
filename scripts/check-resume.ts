/**
 * Resume tailoring check.
 *
 * Builds a small but awkward .docx in memory (title style, a bold employer run with
 * a tab-aligned italic date, numbered bullets, a mixed-format bullet, a table cell,
 * section properties, a styles part), then runs the real pipeline over it:
 *
 *   read paragraphs -> compose prompt -> parse a messy pasted reply -> apply edits
 *   -> read the result back, check formatting and untouched parts -> fact check -> PDF
 *
 *   npm run check:resume
 */

import { JSDOM } from 'jsdom'
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate'

const dom = new JSDOM('')
const g = globalThis as Record<string, unknown>
g.DOMParser = dom.window.DOMParser
g.XMLSerializer = dom.window.XMLSerializer

const { readDocxParagraphs, applyDocxEdits } = await import('../extension/src/resume/docx.ts')
const { buildTailorPrompt, parseTailorReply, parseCoverLetterReply, extractJson } = await import(
  '../extension/src/ai/prompts.ts'
)
const { checkFacts } = await import('../extension/src/resume/fact-check.ts')
const { renderResumePdf, renderLetterPdf } = await import('../extension/src/resume/pdf.ts')
const { applyParagraphEdits } = await import('../extension/src/resume/resume-generator.ts')

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const tab = (props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:tab/></w:r>`
// Numeric style ids, as Word and WPS write for many templates: the *names* say what they are.
const bulletPr = '<w:pPr><w:pStyle w:val="19"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:jc w:val="left"/></w:pPr>'

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="15"/></w:pPr>${run('John Doe')}</w:p>
<w:p><w:pPr><w:pStyle w:val="14"/></w:pPr>${run('senior software engineer')}</w:p>
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('john@example.com | San Francisco, CA')}</w:p>
<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr>${run('Experience')}</w:p>
<w:p>${run('Acme Corp', '<w:b/>')}${run(', Senior Engineer')}${tab()}${run('2019 - 2023', '<w:i/>')}</w:p>
<w:p>${bulletPr}${run('Built payment APIs in Go and PostgreSQL serving 2M requests a day')}</w:p>
<w:p>${bulletPr}${run('Led a team of 4 engineers on ')}${run('internal tooling', '<w:b/>')}${run(' for support staff')}</w:p>
<w:p>${bulletPr}${run('Built a checkout with ')}${run('React', '<w:b/>')}${run(' and ')}${run('Node.js', '<w:b/>')}${run(', cutting failed payments by 30%')}</w:p>
<w:p>${bulletPr}${run('Organised the office book club')}</w:p>
<w:p>${run('Backend: ', '<w:b/>')}</w:p>
<w:p></w:p>
<w:tbl><w:tr><w:tc><w:p>${run('Skills: Go, TypeScript, PostgreSQL, AWS')}</w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>${run('References available on request')}</w:p>
</w:body></w:document>`

const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="15"><w:name w:val="Title"/><w:basedOn w:val="1"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="14"><w:name w:val="Subtitle"/><w:basedOn w:val="1"/><w:rPr><w:caps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/><w:basedOn w:val="1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:caps/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="19"><w:name w:val="List Paragraph"/><w:basedOn w:val="1"/><w:pPr><w:jc w:val="center"/></w:pPr></w:style>
</w:styles>`

const master = zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8(documentXml),
  'word/styles.xml': strToU8(stylesXml),
  'word/media/logo.png': new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
})

// ---------------------------------------------------------------------------

console.log('\n--- Reading the master ----------------------------------------\n')

const paragraphs = readDocxParagraphs(master)
const byText = (needle: string) => paragraphs.find((p) => p.text.includes(needle))!

expect(paragraphs.length === 12, `12 text paragraphs read, empty one skipped (got ${paragraphs.length})`)
const title = byText('John Doe')
expect(title.role === 'title' && title.align === 'center', 'Title found through a numeric style id, centring inherited from the style')
expect(title.bold && title.caps === true && title.sizePt === 22, 'bold, ALL CAPS and 22pt resolved from the style, not the run')
expect(byText('senior software').role === 'subtitle' && byText('senior software').caps === true, 'subtitle with caps resolved')
expect(byText('Experience').role === 'heading', 'heading found by style name "heading 1"')
expect(byText('john@example.com').sizePt === 11, 'document default size (docDefaults) applied')
expect(byText('Built payment').role === 'bullet', 'numbered paragraph read as a bullet')
expect(byText('Built payment').align === 'left', 'paragraph alignment overrides the style (List Paragraph is centred)')
expect(byText('Backend:').bold && byText('Backend:').role === 'body', 'bold label read as a bold body paragraph')
expect((byText('Built a checkout').spans ?? []).filter((s) => s.bold).map((s) => s.text).join() === 'React,Node.js', 'bold keywords captured as spans')
expect(byText('Acme Corp').text === 'Acme Corp, Senior Engineer\t2019 - 2023', 'runs joined, tab kept as \\t')
expect(Boolean(byText('Skills:')), 'table cell paragraph included')

const employer = byText('Acme Corp')
const payments = byText('Built payment')
const tooling = byText('Led a team')
const checkout = byText('Built a checkout')
const bookClub = byText('book club')
const heading = byText('Experience')
const label = byText('Backend:')
const skills = byText('Skills:')

console.log('\n--- Prompt and a messy pasted reply ---------------------------\n')

const jd = 'Stripe is hiring a Senior Backend Engineer. You will build payment APIs in Go. Experience with Kubernetes and Kafka required. PostgreSQL a plus.'
const prompt = buildTailorPrompt({
  paragraphs,
  tailoringPrompt: 'Tailor my resume.',
  additionalInstructions: 'Lead with payments.',
  jobDescription: jd,
  company: 'Stripe',
  position: 'Senior Backend Engineer',
})
expect(prompt.includes(`[P${employer.id}] Acme Corp, Senior Engineer\\t2019 - 2023`), 'prompt lists paragraphs with ids and escaped tabs')
expect(prompt.includes(`[P${heading.id} heading] Experience`), 'prompt marks paragraph roles')
expect(prompt.includes('Lead with payments.'), 'one-off instructions included')

const reply = `Sure! Here is the tailored version:

\`\`\`json
{
  "edits": [
    {"id": ${payments.id}, "text": "Designed and built payment APIs in Go and PostgreSQL handling 2M requests a day, deployed on Kubernetes"},
    {"id": ${employer.id}, "text": "Acme Corp, Senior Backend Engineer\\t2019 - 2023"},
    {"id": ${tooling.id}, "text": "Led a team of 4 engineers on internal tooling for support staff, cutting ticket time by 40%"},
    {"id": ${checkout.id}, "text": "Cut failed payments by 30% with a Node.js payment service behind a React checkout"},
    {"id": 999, "text": "ghost"}
  ],
  "removed": [${bookClub.id}, ${heading.id}, ${label.id}],
  "notes": ["Emphasised payments work"]
}
\`\`\`
Let me know if you want changes!`

const parsed = parseTailorReply(reply, paragraphs)
expect(parsed.edits.length === 5, `4 rewrites + 1 bullet removal accepted (got ${parsed.edits.length})`)
expect(parsed.ignored.some((m) => m.includes('999')), 'edit for a non-existent paragraph ignored and reported')
expect(parsed.ignored.some((m) => m.includes('"Experience"') && m.includes('only bullet')), 'heading removal refused')
expect(parsed.ignored.some((m) => m.includes('Backend:') && m.includes('only bullet')), 'bold label removal refused (the "Backend:" bug)')

let promptRejected = ''
try {
  parseTailorReply(prompt, paragraphs)
} catch (error) {
  promptRejected = (error as Error).message
}
expect(promptRejected.includes('This is the prompt, not the reply'), 'pasting the prompt back is rejected (the "rewritten paragraph" bug)')
expect(!/"id":\s*\d/.test(prompt), 'the format example in the prompt is not itself parseable as edits')
expect(parsed.notes[0] === 'Emphasised payments work', 'change notes kept')
expect(extractJson('no json here') === null, 'a reply with no JSON is detected')

let threw = false
try {
  parseTailorReply('I cannot help with that.', paragraphs)
} catch {
  threw = true
}
expect(threw, 'an unusable reply raises a user-facing error')

console.log('\n--- Applying edits to the .docx -------------------------------\n')

const output = applyDocxEdits(master, parsed.edits)
const outFiles = unzipSync(output)
const outXml = strFromU8(outFiles['word/document.xml']!)
const after = readDocxParagraphs(output)

expect(outXml.startsWith('<?xml'), 'XML declaration preserved')
expect(strFromU8(outFiles['word/styles.xml']!) === stylesXml, 'styles part byte-identical')
expect(outFiles['word/media/logo.png']!.join() === '137,80,78,71,1,2,3,4', 'binary media byte-identical')
expect(Object.keys(outFiles).join() === Object.keys(unzipSync(master)).join(), 'same parts in the same order')

expect(after.some((p) => p.text.startsWith('Designed and built payment APIs')), 'bullet rewritten')
expect(!after.some((p) => p.text.includes('book club')), 'removed bullet gone')
expect(after.some((p) => p.text === 'Experience'), 'heading kept despite removal request')
expect(after.some((p) => p.text === 'Acme Corp, Senior Backend Engineer\t2019 - 2023'), 'tabbed line rewritten with tab intact')
expect(after.find((p) => p.text.startsWith('Designed'))!.role === 'bullet', 'rewritten bullet keeps its numbering')
expect(after.some((p) => p.text === skills.text), 'untouched table paragraph unchanged')

// Formatting survival: the bold employer name and italic date keep their own runs.
const doc = new dom.window.DOMParser().parseFromString(outXml, 'application/xml')
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const employerP = Array.from(doc.getElementsByTagNameNS(W, 'p')).find((p) => (p.textContent ?? '').startsWith('Acme Corp'))!
const employerRuns = Array.from(employerP.getElementsByTagNameNS(W, 'r'))
const boldRun = employerRuns.find((r) => r.textContent === 'Acme Corp')
const italicRun = employerRuns.find((r) => r.textContent === '2019 - 2023')
expect(Boolean(boldRun?.getElementsByTagNameNS(W, 'b').length), 'unchanged bold prefix run kept its bold')
expect(Boolean(italicRun?.getElementsByTagNameNS(W, 'i').length), 'unchanged italic date run kept its italics')

const toolingP = Array.from(doc.getElementsByTagNameNS(W, 'p')).find((p) => (p.textContent ?? '').startsWith('Led a team'))!
const toolingBold = Array.from(toolingP.getElementsByTagNameNS(W, 'r')).find((r) => r.textContent === 'internal tooling')
expect(
  Boolean(toolingBold?.getElementsByTagNameNS(W, 'b').length),
  'a bold phrase inside a rewritten bullet keeps its bold when the rewrite keeps the phrase',
)
expect(
  toolingP.textContent === 'Led a team of 4 engineers on internal tooling for support staff, cutting ticket time by 40%',
  'rewritten mixed-format bullet reads correctly',
)

// Reordered rewrite: bold keywords must stay bold wherever they moved to.
const checkoutAfter = readDocxParagraphs(output).find((p) => p.text.startsWith('Cut failed payments'))!
expect(
  (checkoutAfter.spans ?? []).filter((s) => s.bold).map((s) => s.text).join() === 'Node.js,React',
  `bold keywords kept after the model reordered them (${JSON.stringify(checkoutAfter.spans)})`,
)
expect(
  !(checkoutAfter.spans ?? []).some((s) => s.bold && /failed|service|checkout/.test(s.text)),
  'nothing else became bold',
)

console.log('\n--- Fabrication check -----------------------------------------\n')

const context = { source: paragraphs.map((p) => p.text).join('\n'), jobDescription: jd, allowed: ['Stripe'] }
const paymentWarnings = checkFacts(parsed.edits.find((e) => e.id === payments.id)!.text, context).map((w) => w.message)
const toolingWarnings = checkFacts(parsed.edits.find((e) => e.id === tooling.id)!.text, context).map((w) => w.message)
expect(paymentWarnings.some((m) => m.includes('Kubernetes')), 'a JD technology absent from the master is flagged')
expect(!paymentWarnings.some((m) => m.includes('PostgreSQL') || m.includes('"Go"')), 'technologies the master already has are not flagged')
expect(!paymentWarnings.some((m) => m.includes('2m')), 'a number the master already states is not flagged')
expect(toolingWarnings.some((m) => m.includes('40%')), 'an invented metric is flagged')
expect(
  checkFacts('Dear [Hiring Manager Name], I am applying to Stripe.', context).some((w) => w.message.includes('Placeholder')),
  'a leftover placeholder is flagged',
)

console.log('\n--- Outputs ---------------------------------------------------\n')

const tailored = applyParagraphEdits(paragraphs, parsed.edits)
expect(tailored.length === paragraphs.length - 1, 'PDF paragraphs = master minus removed')
const pdf = await renderResumePdf(
  [...tailored, { id: 900, text: 'Unicode → arrows, ★ stars, é accents', role: 'body', bold: false, align: 'left' }],
  'Stripe_Senior_Backend_Engineer_Resume',
)
expect(strFromU8(pdf.slice(0, 5)) === '%PDF-', `resume PDF produced (${pdf.length} bytes), unsupported characters did not throw`)

const letter = parseCoverLetterReply('Here is your letter:\nBEGIN LETTER\nDear Hiring Team,\n\nI build payment systems.\n\n\n\nBest,\nJohn Doe\nEND LETTER\nHope this helps!')
expect(letter.startsWith('Dear Hiring Team,') && letter.endsWith('John Doe'), 'letter extracted between markers, chatter dropped')
expect(!letter.includes('\n\n\n'), 'excess blank lines collapsed')
const letterPdf = await renderLetterPdf(letter, { name: 'John Doe', contact: 'john@example.com' }, 'Letter')
expect(strFromU8(letterPdf.slice(0, 5)) === '%PDF-', 'cover letter PDF produced')

console.log('\n--- Drafted answers: grounded in your profile ------------------\n')

const { buildAnswerPrompt } = await import('../extension/src/ai/prompts.ts')
const { applicantFacts } = await import('../extension/src/resume/cover-letter.ts')
const { EMPTY_PROFILE: BLANK } = await import('../extension/src/shared/constants/defaults.ts')

const me = {
  ...BLANK,
  personal: { ...BLANK.personal, fullName: 'Daniel Garcia', city: 'Riga', country: 'Latvia' },
  workAuthorization: { workAuthorization: 'I am authorized to work in the US', sponsorshipRequired: 'No' },
}
const facts = applicantFacts(me)
expect(facts.includes('Where I live: Riga, Latvia') && facts.includes('Visa sponsorship needed: No'), 'your location and sponsorship answer are given to the AI')
expect(!facts.includes('Expected salary') && !facts.includes('Notice period'), 'blank profile fields are not listed (nothing to guess from)')

const answerPrompt = buildAnswerPrompt({
  question: 'Where are you physically located? Please include the time zone.',
  jobDescription: jd,
  company: 'Stripe',
  position: 'Engineer',
  resumeText: 'resume',
  facts,
  voice: 'I like small teams and shipping things people use.',
})
expect(answerPrompt.includes('overrides the resume') && answerPrompt.includes('[ADD:'), 'the prompt says profile facts win and unknown facts stay [ADD: ...], never guessed')
expect(answerPrompt.includes('Never use these words') && answerPrompt.includes('I like small teams'), 'plain-voice rules and your own writing sample are included')

const answerContext = { source: `resume text\n${facts}`, jobDescription: jd, allowed: ['Stripe'], checkNames: true }
const invented = checkFacts('I am currently based in China, so my time zone is CST.', answerContext).map((w) => w.message)
expect(invented.some((m) => m.includes('"China"')), `an invented place is flagged ("China" - the bug in your screenshot)`)
const truthful = checkFacts('I live in Riga, Latvia, so I am on Eastern European Time. I work well with Stripe teams.', answerContext).map((w) => w.message)
expect(!truthful.some((m) => m.includes('Riga') || m.includes('Latvia') || m.includes('Stripe')), `places from your profile and the company are not flagged (${truthful.join(' | ')})`)
const gap = checkFacts('I can start [ADD: start date].', answerContext).map((w) => w.message)
expect(gap.some((m) => m.startsWith('Missing fact: start date')), 'a gap the AI left is shown as "Missing fact: ..."')

console.log('\n--- Profile defaults from the resume ----------------------------\n')

const { extractProfile, mergeSuggestions } = await import('../extension/src/resume/profile-extract.ts')
const { EMPTY_PROFILE } = await import('../extension/src/shared/constants/defaults.ts')
const suggested = extractProfile(paragraphs)
const valueOf = (name: string) => suggested.find((s) => s.name === name)?.value

expect(valueOf('fullName') === 'John Doe' && valueOf('firstName') === 'John' && valueOf('lastName') === 'Doe', 'name read from the title and split')
expect(valueOf('email') === 'john@example.com', 'email read from the contact line')
expect(valueOf('city') === 'San Francisco' && valueOf('state') === 'CA', 'US location read as city + state')
expect(valueOf('currentTitle') === 'Senior Software Engineer', `no current job: title from the headline, title-cased (${valueOf('currentTitle')})`)
expect(!valueOf('currentCompany'), 'a past employer is not proposed as the current company')
expect(!valueOf('phone') && !valueOf('portfolio'), 'nothing proposed that the resume does not state')
expect(suggested.every((s) => s.source.length > 0), 'every suggestion shows where it came from')

const withEmail = { ...EMPTY_PROFILE, personal: { ...EMPTY_PROFILE.personal, email: 'me@own.com' } }
const onlyEmpty = mergeSuggestions(withEmail, suggested, true)
expect(onlyEmpty.profile.personal.email === 'me@own.com', 'automatic fill never overwrites a value the user entered')
expect(onlyEmpty.profile.personal.city === 'San Francisco', 'automatic fill fills the empty fields')
expect(mergeSuggestions(withEmail, suggested, false).profile.personal.email === 'john@example.com', 'an explicit choice can replace a value')

const realistic = extractProfile([
  { id: 1, text: 'JANE ROE', role: 'title', bold: true, align: 'center' },
  { id: 2, text: 'jane@roe.dev | +34 612 345 678 | Madrid, Spain | github.com/janeroe', role: 'body', bold: false, align: 'center' },
  { id: 3, text: 'Summary', role: 'heading', bold: true, align: 'left' },
  { id: 4, text: 'Engineer with 6+ years building payment systems.', role: 'body', bold: false, align: 'left' },
  { id: 5, text: 'Skills', role: 'heading', bold: true, align: 'left' },
  { id: 6, text: 'Backend: Node.js (Express, NestJS), Go, SQL Server', role: 'bullet', bold: false, align: 'left' },
  { id: 7, text: 'Database design, indexing, query optimization', role: 'bullet', bold: false, align: 'left' },
  { id: 8, text: 'Experience', role: 'heading', bold: true, align: 'left' },
  { id: 9, text: 'Staff Engineer | Stripe | Remote\t2022 - Present', role: 'body', bold: true, align: 'left' },
  { id: 10, text: 'Engineer | Acme\t2018 - 2022', role: 'body', bold: true, align: 'left' },
])
const real = (name: string) => realistic.find((s) => s.name === name)?.value
expect(real('fullName') === 'Jane Roe', 'an ALL-CAPS name is title-cased')
expect(real('phone') === '+34 612 345 678' && real('github') === 'https://github.com/janeroe', 'phone and GitHub read')
expect(real('country') === 'Spain', 'non-US region read as the country')
expect(real('currentTitle') === 'Staff Engineer' && real('currentCompany') === 'Stripe', 'current role = the job marked Present')
expect(real('yearsOfExperience') === '6+', 'years taken as stated in the summary')
expect(real('primarySkills') === 'Node.js (Express, NestJS), Go, SQL Server', `skills listed; prose line skipped (${real('primarySkills')})`)

// Name and headline in one paragraph, split by a line break (as in the user's CV).
const sharedLine = extractProfile([
  { id: 0, text: 'AGAMYRAT AKMYRADOV\nSenior Software Engineer | Python, Healthcare AI & Full Stack', role: 'body', bold: true, align: 'center' },
  { id: 1, text: 'Bucharest, Romania | +40 791 392 970 | aagamyrat302@gmail.com', role: 'body', bold: false, align: 'center' },
  { id: 2, text: 'Professional Summary', role: 'heading', bold: true, align: 'left' },
  { id: 3, text: 'Engineer with 8+ years of experience.', role: 'body', bold: false, align: 'left' },
])
const shared = (name: string) => sharedLine.find((s) => s.name === name)?.value
expect(
  shared('firstName') === 'Agamyrat' && shared('lastName') === 'Akmyradov' && shared('fullName') === 'Agamyrat Akmyradov',
  `name read from the first line of a name + headline paragraph (${shared('fullName')})`,
)
expect(shared('currentTitle') === 'Senior Software Engineer', `headline line gives the current title (${shared('currentTitle')})`)
expect(shared('city') === 'Bucharest' && shared('country') === 'Romania', 'city and country read')

console.log('\n--- Contact redaction (Gemini free tier) ------------------------\n')

const { redactContacts } = await import('../extension/src/ai/redact.ts')
const contactLine =
  'danielgarcia84.pro@gmail.com | +34 612 345 678 | Madrid, Spain | www.LinkedIn.com/in/daniel-garcia-37a99b37b'
const body = 'Software Engineer 2019 - 2021. Served 5,000+ patients, 2M requests a day, 30% fewer failures.'
const redaction = redactContacts(`${contactLine}\n${body}`)

expect(!redaction.text.includes('@gmail.com'), 'email hidden from the prompt')
expect(!redaction.text.includes('612 345 678'), 'phone number hidden from the prompt')
expect(!/linkedin\.com/i.test(redaction.text), 'LinkedIn link hidden from the prompt')
expect(redaction.text.includes(body), `years, counts and metrics untouched (${JSON.stringify(redaction.text.split('\n')[1])})`)
expect(redaction.count === 3, `exactly 3 values replaced (got ${redaction.count})`)
expect(
  redaction.restore(`Contact: ${redaction.text.split('\n')[0]}\nEmail me at [EMAIL-1].`) ===
    `Contact: ${contactLine}\nEmail me at danielgarcia84.pro@gmail.com.`,
  'placeholders in the reply are restored to the real values',
)

console.log('\n--- Gemini provider (mocked network) ---------------------------\n')

const storage = (data: Record<string, unknown>) => ({
  get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
  set: async () => {},
  remove: async () => {},
})
;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    session: storage({ geminiApiKey: 'test-key' }),
    local: storage({}),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

let sent: { url: string; headers: Record<string, string>; body: string } | null = null
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent = { url, headers: init.headers as Record<string, string>, body: String(init.body) }
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: 'STOP',
          content: { parts: [{ text: 'private reasoning', thought: true }, { text: 'Reach me at [EMAIL-1].' }] },
        },
      ],
    }),
    { status: 200 },
  )
}) as typeof fetch

const { GeminiApiProvider } = await import('../extension/src/ai/gemini.provider.ts')
const geminiReply = await new GeminiApiProvider().complete(`Write a note. My email: ${'daniel@example.com'}`)
const sentRequest = sent as { url: string; headers: Record<string, string>; body: string } | null

expect(Boolean(sentRequest?.url.endsWith('/models/gemini-3.8-flash:generateContent')), `default model endpoint (${sentRequest?.url})`)
expect(sentRequest?.headers['x-goog-api-key'] === 'test-key', 'API key sent in the x-goog-api-key header, not the URL')
expect(!sentRequest?.body.includes('daniel@example.com') && Boolean(sentRequest?.body.includes('[EMAIL-1]')), 'email redacted on the wire')
expect(geminiReply === 'Reach me at daniel@example.com.', `thought parts dropped, email restored in the reply (${JSON.stringify(geminiReply)})`)

console.log('')
if (failures.length) {
  console.error(`${failures.length} resume check(s) failed.\n`)
  process.exit(1)
}
console.log('All resume checks passed.\n')
