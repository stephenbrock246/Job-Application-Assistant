/**
 * "The chat writes the text, the extension makes the files" check.
 *
 *   npm run check:content
 *
 * A master resume shaped like a real one (name, headline, contact; Summary; Skills
 * as categories with bullets; Work Experience as "Title | Company | Place <tab> dates"
 * lines with bullets; Education) goes through the whole path:
 *
 *   find its parts -> the message to the chat -> a messy chat reply -> edits ->
 *   .docx written and read back -> PDF
 *
 * and the .docx must hold the new text in the old formatting, with companies,
 * places, dates and education untouched. With the real master resume present
 * (Documents/Daniel Garcia.docx) it is checked too; set CONTENT_OUT=<folder> to
 * also write the tailored .docx/.pdf there for a look.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'

const dom = new JSDOM('')
const g = globalThis as Record<string, unknown>
g.DOMParser = dom.window.DOMParser
g.XMLSerializer = dom.window.XMLSerializer

const { readDocxParagraphs, applyDocxEdits } = await import('../extension/src/resume/docx.ts')
const { analyzeResume, contentEdits } = await import('../extension/src/resume/sections.ts')
const { contentMessage, parseContent } = await import('../extension/src/resume/chat-content.ts')
const { applyParagraphEdits } = await import('../extension/src/resume/resume-generator.ts')
const { renderResumePdf } = await import('../extension/src/resume/pdf.ts')
const { checkFacts } = await import('../extension/src/resume/fact-check.ts')

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

// ---------------------------------------------------------------------------
// A master like the real one
// ---------------------------------------------------------------------------

const run = (text: string, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`
const tab = () => '<w:r><w:tab/></w:r>'
const bullet = (body: string) => `<w:p w14:paraId="1A2B3C4D" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:pPr><w:pStyle w:val="19"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>${body}</w:p>`
const heading = (text: string) => `<w:p><w:pPr><w:pStyle w:val="2"/></w:pPr>${run(text)}</w:p>`

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="15"/></w:pPr>${run('Daniel Garcia')}</w:p>
<w:p><w:pPr><w:pStyle w:val="14"/></w:pPr>${run('senior software engineer')}</w:p>
<w:p>${run('dan@example.com | Madrid, Spain | linkedin.com/in/dan')}</w:p>
${heading('Summary')}
<w:p>${run('Full-stack developer with 8 years building e-commerce and health platforms in React and Node.js.')}</w:p>
${heading('Skills')}
<w:p>${run('Frontend: ', '<w:b/>')}</w:p>
${bullet(run('Modern frameworks: React, Angular'))}
${bullet(run('TypeScript, HTML5, CSS3'))}
<w:p>${run('Backend: ', '<w:b/>')}</w:p>
${bullet(run('Node.js, Express, NestJS'))}
${bullet(run('REST and GraphQL APIs'))}
${heading('Work Experience')}
<w:p>${run('Full-Stack Developer | Boozt | Malmo, SE')}${tab()}${run('2021 - Present', '<w:i/>')}</w:p>
${bullet(run('Built a multi-vendor marketplace with ') + run('React', '<w:b/>') + run(' and Node.js on AWS'))}
${bullet(run('Built a payment system with Stripe, reducing failed transactions by 30%'))}
${bullet(run('Built order tracking with WebSockets and Redis'))}
<w:p>${run('Software Engineer | Belitsoft | Warsaw, PL')}${tab()}${run('2019 - 2021', '<w:i/>')}</w:p>
${bullet(run('Built an LMS with Node.js and MongoDB for 10,000+ users'))}
${bullet(run('Designed content storage on PostgreSQL and S3'))}
${heading('Education')}
<w:p>${run('BSc Computer Science | University of Madrid | 2014 - 2017')}</w:p>
<w:p><w:pPr><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:pPr>${run('References on request')}</w:p>
</w:body></w:document>`

const stylesXml = `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="1"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="15"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="14"><w:name w:val="Subtitle"/><w:rPr><w:caps/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="19"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`

const master = zipSync({
  '[Content_Types].xml': strToU8('<Types/>'),
  'word/document.xml': strToU8(documentXml),
  'word/styles.xml': strToU8(stylesXml),
})
const paragraphs = readDocxParagraphs(master)

console.log('\n--- Finding the parts of the resume -----------------------------\n')

const layout = analyzeResume(paragraphs)
expect(layout.name?.text === 'Daniel Garcia', 'the name')
expect(layout.headline?.text === 'senior software engineer', 'the headline under the name (not the contact line)')
expect(layout.summary?.items.length === 1, 'the summary')
expect(layout.skills?.style === 'categories' && layout.skills.items.length === 6, 'skills: categories with bullets')
const jobs = layout.experience?.jobs ?? []
expect(jobs.length === 2 && jobs[0]!.content.length === 3 && jobs[1]!.content.length === 2, 'two positions with their bullets')
const t = jobs[0]!.title!
expect(t && t.paragraph.text.slice(t.start, t.end) === 'Full-Stack Developer', 'the job title inside "Title | Company | Place <tab> dates"')
expect(jobs[0]!.label === 'Full-Stack Developer | Boozt | Malmo, SE | 2021 - Present', `a readable line per position (${jobs[0]!.label})`)

console.log('\n--- The message to the chat --------------------------------------\n')

const message = contentMessage(layout, { company: 'Northwind', position: 'Lead Software Engineer', description: 'We use Vue.js, .NET and Azure.' })
expect(/1\. Full-Stack Developer \| Boozt \| Malmo, SE \| 2021 - Present\n2\. Software Engineer \| Belitsoft/.test(message), 'it lists my positions in order, with company, place and dates')
expect(/Do not change the company, location or dates/.test(message), 'and says those must not change')
expect(/"headline"/.test(message) && /"coverLetter"/.test(message) && /do NOT create files/.test(message), 'it asks for JSON text and a cover letter - not files')
expect(/Frontend, Backend/.test(message), 'it names my current skills categories')
expect(/We use Vue\.js, \.NET and Azure\./.test(message) && !/Built a payment system/.test(message), 'the job is sent; my CV text is not (the chat already has it)')

console.log('\n--- Reading the chat\'s reply ------------------------------------\n')

const reply = `Sure! Here is your tailored content:

\`\`\`json
{
  "headline": "Lead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture",
  "summary": "Lead full-stack engineer with 8 years building e-commerce platforms in **TypeScript** and Node.js.\\n\\nComfortable owning architecture on Azure.",
  "skills": [
    { "category": "Frontend", "items": ["Vue.js, React, TypeScript", "• HTML5, CSS3", "State management"] },
    { "category": "Cloud & DevOps:", "items": ["Azure, AWS, Docker"] }
  ],
  "experience": [
    { "position": 1, "title": "Lead Full-Stack Engineer", "bullets": ["Led a multi-vendor marketplace in React and Node.js on AWS", "Built a payment system with Stripe, reducing failed transactions by 30%", "Built order tracking with WebSockets and Redis", "Set up CI/CD with GitHub Actions", "Mentored 3 engineers"] },
    { "position": 2, "bullets": ["Built an LMS with Node.js and MongoDB for 10,000+ users"] }
  ],
  "coverLetter": "Dear Hiring Team,\\n\\nI build web platforms.\\n\\nDaniel Garcia"
}
\`\`\`
Let me know if you want changes!`

const content = parseContent(reply)
expect(content.headline === 'Lead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture', 'headline read')
expect(content.summary?.includes('in TypeScript and') === true, 'Markdown bold removed from the text')
expect(content.skills?.[0]?.items[1] === 'HTML5, CSS3', 'a bullet character the chat added is dropped')
expect(content.experience?.length === 2 && content.experience[1]!.title === undefined, 'positions read; one without a new title keeps its own')
expect(/^Dear Hiring Team,/.test(content.coverLetter ?? ''), 'the cover letter read')

let bad = ''
try {
  parseContent('I have created your CV! [Download](sandbox:/mnt/data/cv.pdf)')
} catch (error) {
  bad = (error as Error).message
}
expect(/did not reply with the JSON/.test(bad), 'a reply without JSON gives a clear message')

console.log('\n--- The tailored .docx ------------------------------------------\n')

const { edits, notes } = contentEdits(layout, content)
const output = applyDocxEdits(master, edits)
const after = readDocxParagraphs(output)
const texts = after.map((p) => p.text)

expect(texts[1] === content.headline, 'the headline is replaced')
expect(after[1]!.role === 'subtitle' && after[1]!.caps === true, 'in the headline\'s own style')
expect(
  JSON.stringify(texts.slice(4, 6)) ===
    JSON.stringify([
      'Lead full-stack engineer with 8 years building e-commerce platforms in TypeScript and Node.js.',
      'Comfortable owning architecture on Azure.',
    ]),
  'the summary is replaced; a second paragraph is added right after it',
)
const skillsAt = texts.indexOf('Skills')
expect(
  JSON.stringify(texts.slice(skillsAt + 1, skillsAt + 7)) ===
    JSON.stringify(['Frontend:', 'Vue.js, React, TypeScript', 'HTML5, CSS3', 'State management', 'Cloud & DevOps:', 'Azure, AWS, Docker']),
  `skills in the chat's order and categories (${texts.slice(skillsAt + 1, skillsAt + 7).join(' / ')})`,
)
expect(!texts.some((text) => text.startsWith('Backend')), 'a category the chat dropped is gone, with its bullets')
const cloud = after.find((p) => p.text === 'Cloud & DevOps:')!
expect(cloud.bold && cloud.role === 'body', 'a new category is bold like the others')
const added = after.find((p) => p.text === 'State management')!
expect(added.role === 'bullet', 'an added skill is a real bullet of the list')

const job1 = texts.findIndex((text) => text.includes('| Boozt |'))
expect(texts[job1] === 'Lead Full-Stack Engineer | Boozt | Malmo, SE\t2021 - Present', 'job title changed; company, place and dates untouched')
expect(
  JSON.stringify(texts.slice(job1 + 1, job1 + 6)) === JSON.stringify(content.experience![0]!.bullets),
  'its 5 bullets, in order (3 were there: 3 rewritten, 2 added)',
)
expect(after.slice(job1 + 1, job1 + 6).every((p) => p.role === 'bullet'), 'every one a real bullet')
const job2 = texts.findIndex((text) => text.includes('| Belitsoft |'))
expect(texts[job2] === 'Software Engineer | Belitsoft | Warsaw, PL\t2019 - 2021', 'a position without a new title keeps it')
expect(texts[job2 + 1] === 'Built an LMS with Node.js and MongoDB for 10,000+ users' && texts[job2 + 2] === 'Education', 'its 2 bullets became 1')
expect(texts.includes('BSc Computer Science | University of Madrid | 2014 - 2017') && texts.at(-1) === 'References on request', 'education and the rest untouched')

const xml = strFromU8(unzipSync(output)['word/document.xml']!)
const dateRun = /<w:r><w:rPr><w:i\/><\/w:rPr><w:t[^>]*>2021 - Present<\/w:t><\/w:r>/.test(xml)
expect(dateRun, 'the dates keep their own (italic) formatting')
expect((xml.match(/<w:sectPr>/g) ?? []).length === 1, 'page settings are not copied into added paragraphs')
expect((xml.match(/w14:paraId="1A2B3C4D"/g) ?? []).length <= 7, "Word's paragraph ids are not duplicated by copies")
expect(notes.length === 0, `nothing left out (${notes.join('; ')})`)

{
  // A resume with only the name and contact line on top: the headline is added under the name.
  const noHeadline = paragraphs.filter((p) => p.role !== 'subtitle')
  const plain = analyzeResume(noHeadline)
  expect(!plain.headline && plain.contact?.text.startsWith('dan@example.com') === true, 'no headline line: the contact line is not mistaken for one')
  const added = contentEdits(plain, { headline: 'Lead Software Engineer | TypeScript, Vue.js' })
  const insert = added.edits[0]
  expect(
    added.edits.length === 1 && insert?.insert?.after === plain.name!.id && insert.insert.like === plain.contact!.id && added.notes.length === 0,
    'the new headline is added right under the name, styled like the contact line',
  )
  const out = readDocxParagraphs(applyDocxEdits(master, [{ id: paragraphs.find((p) => p.role === 'subtitle')!.id, original: '', text: '', removed: true }, ...added.edits]))
  expect(out[1]?.text === 'Lead Software Engineer | TypeScript, Vue.js' && out[2]?.text.startsWith('dan@example.com'), 'in the .docx: name, headline, contact')
}

console.log('\n--- File names -----------------------------------------------------\n')

{
  const { resumeFileName, coverLetterFileName, jobFolderName } = await import('../extension/src/shared/utils/format.ts')
  expect(jobFolderName('Accesa', 'Technical Lead with React') === 'Accesa_Technical_Lead_with_React', 'one folder per application: Accesa_Technical_Lead_with_React')
  expect(resumeFileName('Agamyrat Akmyradov') === 'Agamyrat_Akmyradov_CV.pdf', 'the CV is named after you: Agamyrat_Akmyradov_CV.pdf')
  expect(resumeFileName('Agamyrat Akmyradov', 'docx') === 'Agamyrat_Akmyradov_CV.docx', 'and the Word copy: Agamyrat_Akmyradov_CV.docx')
  expect(coverLetterFileName('Agamyrat Akmyradov') === 'Agamyrat_Akmyradov_Cover_Letter.pdf', 'the cover letter: Agamyrat_Akmyradov_Cover_Letter.pdf')
  expect(resumeFileName('') === 'CV.pdf', 'no name in the profile yet: CV.pdf')
}

console.log('\n--- PDF and checks -----------------------------------------------\n')

const inMemory = applyParagraphEdits(paragraphs, edits).map((p) => p.text)
expect(JSON.stringify(inMemory) === JSON.stringify(texts), 'the PDF gets exactly the same text, in the same order, as the .docx')
const pdf = await renderResumePdf(applyParagraphEdits(paragraphs, edits), 'Northwind_Lead_Software_Engineer_Resume')
expect(strFromU8(pdf.slice(0, 5)) === '%PDF-', 'the CV PDF is built')

const masterText = paragraphs.map((p) => p.text).join('\n')
const flagged = edits.filter((e) => !e.removed).flatMap((e) => checkFacts(e.text, { source: masterText, jobDescription: 'We use Vue.js, .NET and Azure.' }, e.id))
expect(
  flagged.some((w) => /"Vue\.js" comes from the job description/.test(w.message)) && flagged.some((w) => /"Azure"/.test(w.message)),
  'technologies taken from the job ad but not in my resume are flagged, so that CV waits for my review',
)

console.log('\n--- A resume like Agamyrat\'s: name + headline in one paragraph -----\n')

{
  const ruled = '<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="000000"/></w:pBdr><w:spacing w:before="240" w:after="120"/></w:pPr>'
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p>${run('AGAMYRAT AKMYRADOV', '<w:b/><w:color w:val="1F2A44"/><w:sz w:val="44"/>')}<w:r><w:rPr><w:sz w:val="44"/></w:rPr><w:br/></w:r>${run('Senior Software Engineer | Full Stack Developer', '<w:i/><w:color w:val="7F7F7F"/><w:sz w:val="26"/>')}</w:p>
<w:p>${run('+40 791 392 970  |  agamyrat@example.com  |  Bucharest, Romania')}</w:p>
<w:p>${ruled}${run('PROFESSIONAL SUMMARY', '<w:b/><w:sz w:val="26"/>')}</w:p>
<w:p>${run('Senior Software Engineer with 10+ years in software development, specializing in React, TypeScript, GraphQL and Node.js.')}</w:p>
<w:p>${ruled}${run('TECHNICAL SKILLS', '<w:b/><w:sz w:val="26"/>')}</w:p>
${bullet(run('Frontend: React, TypeScript, JavaScript, Next.js'))}
${bullet(run('Backend: Node.js, Express.js, NestJS, Python'))}
<w:p>${ruled}${run('PROFESSIONAL EXPERIENCE', '<w:b/><w:sz w:val="26"/>')}</w:p>
<w:p>${run('Senior Frontend Engineer', '<w:b/>')}${run(' | Gentoo | Bucharest')}${tab()}${run('2021 - Present')}</w:p>
${bullet(run('Built a design system in React used by 6 product teams'))}
</w:body></w:document>`
  const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml), 'word/styles.xml': strToU8(stylesXml) })
  const ps = readDocxParagraphs(docx)
  const head = ps[0]!
  expect(head.text === 'AGAMYRAT AKMYRADOV\nSenior Software Engineer | Full Stack Developer', 'name and headline read as two lines of one paragraph')
  expect(head.spans?.length === 2 && head.spans[1]!.italic === true && head.spans[1]!.color === '7F7F7F' && head.spans[0]!.sizePt === 22, 'with their own looks: big bold name, grey italic headline')
  const heading = ps.find((p) => p.text === 'PROFESSIONAL SUMMARY')!
  expect(heading.borderBottom === true && heading.spaceBeforePt === 12, 'section headings: the rule under them and their spacing are read')

  const lay = analyzeResume(ps)
  expect(Boolean(lay.headlineInName) && !lay.headline, 'the headline is found as the second line of the name paragraph')
  const { edits: e2, notes: n2 } = contentEdits(lay, {
    headline: 'Lead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture',
    skills: [{ category: 'Frontend', items: ['React, TypeScript, Vue.js'] }, { category: 'Cloud', items: ['Azure, AWS'] }],
  })
  expect(n2.length === 0 && e2[0]?.text === 'AGAMYRAT AKMYRADOV\nLead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture', 'only the headline line is replaced - no second headline is added')
  const tailored = applyParagraphEdits(ps, e2)
  const newHead = tailored[0]!
  expect(newHead.spans?.[1]?.italic === true && newHead.spans[1].color === '7F7F7F' && newHead.spans[0]!.text.startsWith('AGAMYRAT'), 'the new headline keeps the grey italic look; the name stays as it was')
  const docAfter = readDocxParagraphs(applyDocxEdits(docx, e2))
  expect(docAfter[0]!.spans?.[1]?.italic === true && docAfter[0]!.text.includes('\nLead Software Engineer |'), 'and the same in the .docx')

  const bytes = await renderResumePdf(tailored, 'Agamyrat_Akmyradov_CV')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false }).promise
  const content = await (await doc.getPage(1)).getTextContent()
  const items = (content.items as { str: string; transform: number[] }[]).filter((item) => item.str.trim())
  const textOf = items.map((item) => item.str).join(' ')
  expect(!textOf.includes('?'), `no "?" where the line break was (${textOf.slice(0, 70)}...)`)
  const nameItem = items.find((item) => item.str.includes('AGAMYRAT'))!
  const headItem = items.find((item) => item.str.startsWith('Lead '))!
  expect(nameItem && headItem && headItem.transform[5]! < nameItem.transform[5]!, 'the headline is on its own line, under the name')
  expect(nameItem.transform[0]! > headItem.transform[0]!, `the name is larger than the headline (${nameItem.transform[0]} vs ${headItem.transform[0]})`)
  if (process.env.CONTENT_OUT) {
    writeFileSync(join(process.env.CONTENT_OUT, 'agamyrat-style.pdf'), bytes)
    console.log(`      (written to ${process.env.CONTENT_OUT})`)
  }
}

console.log('\n--- Job titles with a technology tagline --------------------------\n')

{
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p>${run('AGAMYRAT AKMYRADOV')}</w:p>
${heading('Professional Experience')}
<w:p>${run('Senior Full Stack Software Engineer | Python, React &amp; Cloud Applications', '<w:b/>')}${tab()}${run('2022 - Present')}</w:p>
<w:p>${run('Andor Health | Remote, US')}</w:p>
${bullet(run('Built React interfaces'))}
<w:p>${run('Full Stack Web Developer | Inovex | Ankara, TR')}${tab()}${run('2017 - 2019')}</w:p>
${bullet(run('Built interactive applications'))}
</w:body></w:document>`
  const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml), 'word/styles.xml': strToU8(stylesXml) })
  const ps = readDocxParagraphs(docx)
  const lay = analyzeResume(ps)
  const [j1, j2] = lay.experience?.jobs ?? []
  expect(j1?.title?.paragraph.text.slice(j1.title.start, j1.title.fullEnd) === 'Senior Full Stack Software Engineer | Python, React & Cloud Applications', 'the tagline is found as part of the title')
  expect(j2?.title?.paragraph.text.slice(j2.title.start, j2.title.fullEnd) === 'Full Stack Web Developer', 'a company and a place are not a tagline')
  const { edits: e3 } = contentEdits(lay, {
    experience: [
      { position: 1, title: 'Senior Full Stack Software Engineer | JavaScript, React & Distributed Services' },
      { position: 2, title: 'Full Stack Web Developer | JavaScript, React & Frontend Performance' },
    ],
  })
  const out = applyParagraphEdits(ps, e3).map((p) => p.text)
  expect(out.includes('Senior Full Stack Software Engineer | JavaScript, React & Distributed Services\t2022 - Present'), `the chat's title replaces the old tagline, not added before it (${out[2]})`)
  expect(out.includes('Full Stack Web Developer | JavaScript, React & Frontend Performance | Inovex | Ankara, TR\t2017 - 2019'), 'company and place kept after a new tagline')
  const { edits: e4 } = contentEdits(lay, { experience: [{ position: 1, title: 'Lead Engineer' }] })
  expect(applyParagraphEdits(ps, e4)[2]?.text === 'Lead Engineer | Python, React & Cloud Applications\t2022 - Present', 'a new title without a tagline keeps the old tagline')
}

console.log('\n--- Bold in the chat\'s new text ----------------------------------\n')

{
  const B = '<w:b/>'
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p>${run('AGAMYRAT AKMYRADOV', B)}</w:p>
${heading('Summary')}
<w:p>${run('Engineer with 10+ years building ')}${run('React', B)}${run(' and ')}${run('Node.js', B)}${run(' applications.')}</w:p>
${heading('Skills')}
${bullet(run('Frontend:', B) + run(' React, TypeScript, JavaScript, Next.js'))}
${bullet(run('Cloud:', B) + run(' AWS'))}
${heading('Professional Experience')}
<w:p>${run('Senior Full Stack Software Engineer', B)}${run(' | Python, React &amp; Cloud Applications')}${tab()}${run('2022 - Present')}</w:p>
${bullet(run('Led the migration to AWS', B) + run(' of 3 apps'))}
${bullet(run('Built ') + run('React', B) + run(' interfaces'))}
</w:body></w:document>`
  const docx = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8(xml), 'word/styles.xml': strToU8(stylesXml) })
  const ps = readDocxParagraphs(docx)
  const { edits: e5 } = contentEdits(analyzeResume(ps), {
    summary: 'Engineer with 10+ years building React apps. Strong in React, Node.js and TypeScript.',
    skills: [
      { category: 'Frontend', items: ['JavaScript, TypeScript, React'] },
      { category: 'Frontend Performance', items: ['Code splitting, lazy loading'] },
      { category: 'Cloud & DevOps', items: ['AWS, GCP, Azure'] },
    ],
    experience: [{ position: 1, title: 'Senior Full Stack Developer | JavaScript, React & Distributed Services', bullets: ['Built React interfaces with TypeScript', 'Designed REST APIs with Node.js', 'Added Playwright tests'] }],
  })
  const boldOf = (list: typeof ps) => list.map((p) => (p.spans?.length ? p.spans : [{ text: p.text, bold: p.bold }]).filter((s) => s.bold).map((s) => s.text.trim()).join('+')).join(' / ')
  const pdfBold = boldOf(applyParagraphEdits(ps, e5))
  const docxBold = boldOf(readDocxParagraphs(applyDocxEdits(docx, e5)))
  const expected = 'AGAMYRAT AKMYRADOV / Summary /  / Skills / Frontend: / Frontend Performance: / Cloud & DevOps: / Professional Experience / Senior Full Stack Developer /  /  / '
  expect(pdfBold === expected, `bold only on the name, headings, skill labels and the job title - not on words of the new text (${pdfBold})`)
  expect(docxBold === pdfBold, `the .docx has the same bold as the PDF (${docxBold})`)
}

console.log('\n--- The real master resume ---------------------------------------\n')

const real = 'C:\\Users\\Administrator\\Documents\\Daniel Garcia.docx'
if (!existsSync(real)) {
  console.log('      (not on this computer - skipped)')
} else {
  const bytes = new Uint8Array(readFileSync(real))
  const realParagraphs = readDocxParagraphs(bytes)
  const realLayout = analyzeResume(realParagraphs)
  const realJobs = realLayout.experience?.jobs ?? []
  expect(realLayout.headline?.text.toLowerCase() === 'senior software engineer', 'headline found')
  expect(Boolean(realLayout.summary) && realLayout.skills?.style === 'categories', 'summary and skills (categories with bullets) found')
  expect(realJobs.length === 3 && realJobs.every((job) => job.title && job.content.length >= 4), `3 positions, each with its title and bullets (${realJobs.map((j) => j.content.length).join(', ')})`)
  expect(realJobs.map((j) => j.title!.paragraph.text.slice(j.title!.start, j.title!.end)).join(' / ') === 'Full-Stack Developer / Software Engineer / Junior Full-Stack Developer', 'the three titles')

  const realEdits = contentEdits(realLayout, {
    headline: 'Lead Software Engineer | TypeScript, Vue.js, Node.js, .NET, Azure & Cloud Architecture',
    summary: 'Full-stack engineer with 8+ years building scalable e-commerce, education and healthcare platforms with TypeScript, React, Vue.js and Node.js, and owning delivery from architecture to production on AWS and Azure.',
    skills: [
      { category: 'Frontend', items: ['Vue.js, React, Angular, TypeScript', 'State management: Redux, Pinia, Context API'] },
      { category: 'Backend', items: ['Node.js (Express, NestJS), .NET', 'RESTful APIs, GraphQL, microservices'] },
      { category: 'Cloud & DevOps', items: ['Azure, AWS, Docker, Kubernetes', 'CI/CD: GitHub Actions, Azure DevOps'] },
    ],
    experience: [
      { position: 1, title: 'Lead Full-Stack Engineer', bullets: ['Developed a scalable multi-vendor e-commerce platform with React and Node.js on AWS, resulting in a 25% faster page load.', 'Built a secure payment system with Node.js, Express and Stripe, reducing failed transactions by 30%.'] },
    ],
  })
  const realOut = applyDocxEdits(bytes, realEdits.edits)
  const realAfter = readDocxParagraphs(realOut).map((p) => p.text)
  expect(realAfter.some((t) => t.startsWith('Lead Full-Stack Engineer | Boozt | Malmo, SE')), 'title replaced, "Boozt | Malmo, SE" and dates kept')
  expect(realAfter.some((t) => t.startsWith('Software Engineer | Belitsoft')), 'positions the reply did not mention are untouched')
  const realLine = applyParagraphEdits(realParagraphs, realEdits.edits).find((p) => p.text.startsWith('Lead Full-Stack Engineer |'))
  expect(
    realLine?.spans?.[0]?.bold === true && realLine.spans[0].text.trim() === 'Lead Full-Stack Engineer' && realLine.spans[1]?.bold === false,
    `the new job title stays bold and " | Boozt | Malmo, SE" regular, like the untouched positions (${JSON.stringify(realLine?.spans?.slice(0, 2))})`,
  )
  const realPdf = await renderResumePdf(applyParagraphEdits(realParagraphs, realEdits.edits), 'Daniel_Garcia_Resume')
  expect(strFromU8(realPdf.slice(0, 5)) === '%PDF-', 'PDF built from the real resume')
  if (process.env.CONTENT_OUT) {
    writeFileSync(join(process.env.CONTENT_OUT, 'tailored.docx'), realOut)
    writeFileSync(join(process.env.CONTENT_OUT, 'tailored.pdf'), realPdf)
    console.log(`      (written to ${process.env.CONTENT_OUT})`)
  }
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All content checks passed.\n')
