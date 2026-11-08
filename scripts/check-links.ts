/**
 * Link-based integrations check.
 *
 *   npm run check:links
 *
 * 1. Google Sheet by link: URL parsing, live read through a mocked Google CSV
 *    response, local outcome notes applied to the queue and dropped once the sheet
 *    shows them, and the "not shared" error.
 * 2. ChatGPT project tailoring: the page runner types into a ChatGPT-like page in
 *    jsdom, sends, waits for a streamed answer to settle and reads the JSON out of
 *    its code block. Project link validation.
 */

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
  url: 'https://chatgpt.com/g/g-p-abc123-jobs/project',
})
const g = globalThis as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.location = dom.window.location
g.HTMLElement = dom.window.HTMLElement
g.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
g.Element = dom.window.Element
g.Node = dom.window.Node
g.Event = dom.window.Event
g.InputEvent = dom.window.InputEvent
g.KeyboardEvent = dom.window.KeyboardEvent

const store = new Map<string, unknown>()
g.chrome = {
  storage: {
    local: {
      get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value)
      },
      remove: async (key: string) => void store.delete(key),
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

let sheetCsv = ''
let sheetHtml = false
let sheetFetches = 0
/** Scripted answers for the next downloads (then back to normal): 'busy' = 429 page, 'signin' = sign-in page. */
let sheetScript: ('busy' | 'signin' | 'ok')[] = []
/** Private sheet: only a request with the browser's Google sign-in gets the data. */
let sheetPrivate = false
g.fetch = async (url: string, init?: { credentials?: string }) => {
  if (!String(url).includes('/export?format=csv')) throw new Error(`unexpected fetch ${url}`)
  sheetFetches++
  const scripted = sheetScript.shift()
  const signin = new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'content-type': 'text/html' } })
  if (scripted === 'busy') return new Response('<html>Too many requests</html>', { status: 429, headers: { 'content-type': 'text/html' } })
  if (scripted === 'signin' || sheetHtml || (sheetPrivate && init?.credentials !== 'include')) return signin
  return new Response(sheetCsv, { status: 200, headers: { 'content-type': 'text/csv' } })
}

const { parseSheetUrl, sheetLinkSlot, sheetLinkUpdatesSlot, SheetLinkJobSource, resetSheetCache } = await import(
  '../extension/src/jobsource/sheet-link/sheet-link.source.ts'
)
// Each sheet change below is read at once, and retries do not wait.
const fresh = () => resetSheetCache({ retryDelaysMs: [0, 0, 0] })
fresh()
const { parseChatGptProjectUrl, isProjectLink, isChatLink, checkChatGptLink } = await import('../extension/src/ai/chatgpt-project.provider.ts')
const { askChatGpt, replyText, findAnswer, findFiles } = await import('../extension/src/content/chatgpt/chatgpt-runner.ts')

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

console.log('\n--- Google Sheet by link ----------------------------------------\n')

{
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
  expect(
    JSON.stringify(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=12345`)) ===
      JSON.stringify({ spreadsheetId: id, gid: '12345' }),
    'edit link with #gid gives the sheet id and tab',
  )
  expect(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`)?.gid === '0', 'share link without gid -> first tab')
  expect(parseSheetUrl('https://example.com/nothing') === null, 'a non-sheet link is refused')

  await sheetLinkSlot.set({ url: `https://docs.google.com/spreadsheets/d/${id}/edit`, spreadsheetId: id, gid: '0', connectedAt: 1 })
  sheetCsv = [
    'Company,Position,Job Link,Status,Other,Applied Date,Resume',
    'Acme,Backend Engineer,https://jobs.acme.com/1,,,,',
    'Beta,Frontend Dev,https://beta.io/jobs/2,Applied,,10/1,',
    'Gamma,Data Engineer,https://gamma.dev/careers/3,,,,',
  ].join('\n')

  const source = new SheetLinkJobSource()
  const first = await source.readJobs()
  expect(first.jobs.length === 3, 'reads 3 jobs live from the sheet')
  expect(first.jobs[0]?.rowNumber === 2 && first.jobs[0]?.company === 'Acme', 'row numbers are the sheet rows')

  await source.updateRow(2, { status: 'Applied', appliedDate: '10/15', resume: 'Acme_Backend Engineer.pdf' })
  const notes = await sheetLinkUpdatesSlot.get()
  expect(notes.length === 1 && notes[0]?.rowNumber === 2, 'Done is kept as a local note for row 2')

  const second = await source.readJobs()
  expect(second.jobs[0]?.status === 'APPLIED', 'the note shows in the queue before the sheet is updated')
  expect(second.jobs[2]?.status !== 'APPLIED', 'other rows are untouched')

  // The user copies the update into the sheet.
  sheetCsv = sheetCsv.replace('https://jobs.acme.com/1,,,,', 'https://jobs.acme.com/1,Applied,,10/15,Acme_Backend Engineer.pdf')
  fresh()
  await source.readJobs()
  expect((await sheetLinkUpdatesSlot.get()).length === 0, 'the note is dropped once the sheet shows it')

  // A row inserted above moves the job: the old note must not land on another job.
  await source.updateRow(4, { status: 'Skipped' })
  sheetCsv = sheetCsv.replace('\nAcme', '\nNew,Inserted,https://new.co/x,,,,\nAcme')
  fresh()
  const shifted = await source.readJobs()
  const gamma = shifted.jobs.find((job) => job.company === 'Gamma')
  const inserted = shifted.jobs.find((job) => job.company === 'Beta')
  expect(gamma?.rowNumber === 5 && gamma.status !== 'SKIPPED', 'a note does not follow a different job into its row')
  expect(inserted?.status === 'APPLIED', 'existing statuses still read correctly after the shift')

  // --- Google limiting how often a sheet is downloaded (the "not shared" message while it was) ---

  // Opening a job reads the sheet three times at once: one download serves them all.
  fresh()
  sheetFetches = 0
  await Promise.all([source.readJobs(), source.updateRow(5, { status: 'In Progress' }), source.verifyRow(5, 'https://jobs.acme.com/1')])
  expect(sheetFetches === 1, `reading the sheet three times at once downloads it once (${sheetFetches})`)

  // Google answers "too many requests" twice, then the data: retried, no error.
  fresh()
  sheetScript = ['busy', 'busy']
  const retried = await source.readJobs().catch((error: Error) => error)
  expect(!(retried instanceof Error) && retried.jobs.length === 4, 'Google busy (429) twice: retried, and the jobs are read')

  // Google stays busy, but the sheet was read a moment ago: that copy is used.
  await new Promise((resolve) => setTimeout(resolve, 0))
  sheetScript = ['busy', 'busy', 'busy', 'busy', 'busy']
  const realNow = Date.now
  Date.now = () => realNow() + 60_000 // a minute later: too old to reuse, young enough to fall back on
  const fallback = await source.readJobs().catch((error: Error) => error)
  Date.now = realNow
  expect(!(fallback instanceof Error) && fallback.jobs.length === 4, 'Google busy for a while: the copy from a minute ago is used - no error')
  sheetScript = []

  // Busy and nothing read yet: the message says Google is busy - not "not shared".
  fresh()
  sheetScript = ['busy', 'busy', 'busy', 'busy', 'busy']
  let busy = ''
  await source.readJobs().catch((error: Error) => (busy = error.message))
  expect(/not answering right now \(HTTP 429\)/.test(busy) && !/Anyone with the link/.test(busy), `Google busy: "${busy.slice(0, 60)}..." - not the sharing message`)
  sheetScript = []

  // A private sheet (shared with the user's own Google account): read with their sign-in.
  fresh()
  sheetPrivate = true
  const privateRead = await source.readJobs().catch((error: Error) => error)
  expect(!(privateRead instanceof Error) && privateRead.jobs.length === 4, 'a private sheet the user can open is read with their sign-in')
  sheetPrivate = false

  fresh()
  sheetHtml = true
  let message = ''
  await source.readJobs().catch((error: Error) => (message = error.message))
  expect(/Anyone with the link/.test(message), 'a sheet that is really not shared still gives the "share as viewer" instruction')
  sheetHtml = false
  fresh()
}

console.log('\n--- ChatGPT project tailoring -----------------------------------\n')

{
  expect(parseChatGptProjectUrl('https://chatgpt.com/g/g-p-abc123-jobs/project') !== null, 'project link accepted')
  expect(isProjectLink('https://chatgpt.com/g/g-p-abc123-jobs/project'), 'project link recognised as a project')
  expect(!isProjectLink('https://chatgpt.com/'), 'home page is not a project')
  expect(parseChatGptProjectUrl('https://evil.example.com/chatgpt.com') === null, 'other hosts refused')
  expect(parseChatGptProjectUrl('http://chatgpt.com/') === null, 'plain http refused')
  expect(parseChatGptProjectUrl('https://chatgpt.com/share/6802f1a2-1234-4abc-9def-0123456789ab') === null, 'Share links refused (read-only copy)')
  expect(/address bar/.test(checkChatGptLink('https://chatgpt.com/share/abc').error ?? ''), 'Share link error says to copy the address bar')
  const chatLink = 'https://chatgpt.com/g/g-p-6ad0bc5fe89c-job-application/c/68f0a1b2-1234-8000-9abc-0123456789ab'
  expect(parseChatGptProjectUrl(chatLink) === chatLink && isChatLink(chatLink), 'chat link inside a project accepted as a chat')
  expect(isChatLink('https://chatgpt.com/c/68f0a1b2-1234-8000-9abc-0123456789ab'), 'plain chat link recognised')

  const document = dom.window.document
  const app = document.getElementById('app')!
  app.innerHTML = `
    <div id="thread"></div>
    <form><textarea id="prompt-textarea"></textarea>
    <button data-testid="send-button" type="button" disabled>Send</button></form>`
  const composer = document.getElementById('prompt-textarea') as HTMLTextAreaElement
  const send = document.querySelector('[data-testid="send-button"]') as HTMLButtonElement
  composer.addEventListener('input', () => (send.disabled = !composer.value.trim()))

  let sent = ''
  const json = '{"edits":[{"id":3,"text":"Built Go services"}],"removed":[],"notes":[]}'
  const thread = document.getElementById('thread')!
  const addMessage = (role: string, html: string, atStart = false) => {
    const element = document.createElement('div')
    element.setAttribute('data-message-author-role', role)
    element.innerHTML = html
    if (atStart) thread.prepend(element)
    else thread.appendChild(element)
    return element
  }
  // An existing chat: earlier answers, and more history that renders late.
  addMessage('user', 'This is my original resume.')
  addMessage('assistant', '<p>Please paste the first job description.</p>')
  setTimeout(() => addMessage('assistant', '<pre><code>{"edits":[{"id":1,"text":"OLD"}]}</code></pre>', true), 100)

  send.addEventListener('click', () => {
    sent = composer.value
    composer.value = ''
    addMessage('user', sent.replace(/\n/g, '<br>'))
    // ChatGPT streams the answer in pieces while a Stop button is shown.
    const message = document.createElement('div')
    message.setAttribute('data-message-author-role', 'assistant')
    thread.appendChild(message)
    const stop = document.createElement('button')
    stop.setAttribute('data-testid', 'stop-button')
    app.appendChild(stop)
    const pieces = ['Here are the edits:', '<pre><div>json</div><div>Copy code</div><code>{"edits":[', `<pre><div>json</div><div>Copy code</div><code>${json}</code></pre>`]
    pieces.forEach((html, index) => setTimeout(() => (message.innerHTML = `<p>Here are the edits:</p>${index ? html : ''}`), 200 * (index + 1)))
    setTimeout(() => stop.remove(), 900)
  })

  const started = Date.now()
  const result = await askChatGpt('[P3] Built services\nJOB: Go engineer', 30_000)
  expect(sent.includes('JOB: Go engineer'), 'the prompt was typed and sent')
  expect(/^\(ref JA-[a-z0-9]+\)/.test(sent), 'the message starts with a reference to find its answer')
  expect(result.reply === json, 'the reply is the new answer\'s JSON - not an older answer, not "json"/"Copy code"')
  expect(Date.now() - started >= 900, 'it waited for the answer to finish streaming')

  // ChatGPT collapses a long message: the page shows only part of it, without the reference.
  // A thinking model also shows a "thinking" message before the answer.
  {
    const thread2 = document.getElementById('thread')!
    const send2 = document.querySelector('[data-testid="send-button"]') as HTMLButtonElement
    const composer2 = document.getElementById('prompt-textarea') as HTMLTextAreaElement
    const clone = send2.cloneNode(true) as HTMLButtonElement
    send2.replaceWith(clone)
    composer2.addEventListener('input', () => (clone.disabled = !composer2.value.trim()))
    const answer2 = '{"edits":[],"removed":[],"notes":["second"]}'
    clone.addEventListener('click', () => {
      composer2.value = ''
      const user = document.createElement('div')
      user.setAttribute('data-message-author-role', 'user')
      user.textContent = 'Tailor my resume for this job... Show more'
      thread2.appendChild(user)
      setTimeout(() => {
        const thinking = document.createElement('div')
        thinking.setAttribute('data-message-author-role', 'assistant')
        thinking.textContent = 'Thought for 20s'
        thread2.appendChild(thinking)
      }, 200)
      setTimeout(() => {
        const final = document.createElement('div')
        final.setAttribute('data-message-author-role', 'assistant')
        final.innerHTML = `<pre><code>${answer2}</code></pre>`
        thread2.appendChild(final)
      }, 500)
    })
    const second = await askChatGpt('another job', 30_000)
    expect(second.reply === answer2, 'a collapsed message still gets its answer (the final one, not "thinking")')
  }

  // ChatGPT's own conversation record: our message, a "thinking" step, the answer.
  {
    const node = (role: string, type: string, parts: string[], children: string[], extra: Record<string, unknown> = {}) => ({
      children,
      message: { author: { role }, content: { content_type: type, parts }, ...extra },
    })
    const mapping = {
      root: { children: ['old'] },
      old: node('user', 'text', ['This is my original resume.'], ['oldAnswer']),
      oldAnswer: node('assistant', 'text', ['Please paste the first job description.'], ['ask'], { status: 'finished_successfully', end_turn: true }),
      ask: node('user', 'text', ['(ref JA-abc123)\n\nTailor...'], ['think']),
      think: node('assistant', 'thoughts', ['weighing keywords'], ['answer']),
      answer: node('assistant', 'text', ['{"edits":[]}'], [], { status: 'in_progress', end_turn: null }),
    }
    const streaming = findAnswer(mapping, 'JA-abc123')
    expect(streaming.found && streaming.text === '{"edits":[]}' && !streaming.done, 'record: answer found, not finished while streaming')
    mapping.answer.message = { ...mapping.answer.message, status: 'finished_successfully', end_turn: true } as typeof mapping.answer.message
    const finished = findAnswer(mapping, 'JA-abc123')
    expect(finished.done && finished.text === '{"edits":[]}', 'record: finished answer returned (not the thinking, not the old answer)')
    expect(!findAnswer(mapping, 'JA-zzzzzz').found, 'record: another reference is not our message')

    // Files ChatGPT created: a link to a file its code wrote, and an attached file.
    const files = {
      root: { children: ['oldAsk'] },
      oldAsk: node('user', 'text', ['(ref JA-old111) earlier job'], ['oldReply']),
      oldReply: node('assistant', 'text', ['[Old](sandbox:/mnt/data/Old_Resume.pdf)'], ['ask']),
      ask: node('user', 'text', ['(ref JA-new222)\n\nCompany: ayble'], ['code']),
      code: node('assistant', 'code', ['make_pdf()'], ['tool']),
      tool: node('tool', 'execution_output', ['done'], ['reply']),
      reply: node('assistant', 'text', ['Here it is: [Download the resume](sandbox:/mnt/data/Agamyrat_Ayble%20Resume.pdf)'], [], {
        status: 'finished_successfully',
        end_turn: true,
      }),
    }
    const created = findFiles(files, 'JA-new222')
    expect(
      created.length === 1 && created[0]?.kind === 'sandbox' && created[0].messageId === 'reply' && created[0].name === 'Agamyrat_Ayble Resume.pdf',
      'file: the PDF link in this answer is found with its message id (not an older answer\'s file)',
    )
    const attached = {
      ask: node('user', 'text', ['(ref JA-att333) job'], ['reply']),
      reply: node('assistant', 'text', ['Your resume is attached.'], [], {
        metadata: { attachments: [{ id: 'file-AbC123', name: 'Resume.pdf', mime_type: 'application/pdf' }] },
      }),
    }
    // ChatGPT's newer file cards: markup around the links, spaces in the file names.
    const cards = {
      ask: node('user', 'text', ['(ref JA-box444) job'], ['code']),
      code: node('assistant', 'code', ['doc.save("/mnt/data/Makersite Senior Frontend Engineer CV.pdf")'], ['reply']),
      reply: node(
        'assistant',
        'text',
        [
          '<box gap={3}><row align="center" gap={3}><icon name="file-text" size="2xl"/><box flex={1} gap={1}>**1. Tailored CV**\n' +
            '[Download Tailored CV](sandbox:/mnt/data/Makersite Senior Frontend Engineer CV.pdf)</box></row>\n' +
            '<row>**2. Tailored Cover Letter** [Download Cover Letter](sandbox:/mnt/data/Makersite_Cover_Letter.pdf)</row></box>',
        ],
        [],
        { status: 'finished_successfully', end_turn: true },
      ),
    }
    const carded = findFiles(cards, 'JA-box444') as { kind: string; name: string; messageIds?: string[] }[]
    expect(
      carded.length === 2 && carded[0]?.name === 'Makersite Senior Frontend Engineer CV.pdf' && carded[1]?.name === 'Makersite_Cover_Letter.pdf',
      `file cards with spaces in names are found (${carded.map((f) => f.name).join(' | ')})`,
    )
    expect(
      JSON.stringify(carded[0]?.messageIds) === JSON.stringify(['code', 'reply']),
      'the download is tried against the message that wrote the file, then the others',
    )
    const att = findFiles(attached, 'JA-att333')
    expect(att[0]?.kind === 'file' && att[0].fileId === 'file-AbC123' && att[0].name === 'Resume.pdf', 'file: an attached file is found')
  }

  // The last answer holds editable areas (a canvas document, an "edit" form with its
  // own Send button), earlier on the page than the message box, and the box has no id:
  // the job must go into the message box, never into the answer.
  {
    app.innerHTML = `
      <div id="thread">
        <div data-message-author-role="user">(ref JA-old000) earlier job</div>
        <article data-testid="conversation-turn-2"><div data-message-author-role="assistant">
          <p>Here is your CV:</p>
          <div class="ProseMirror" contenteditable="true" role="textbox">Old CV text in a canvas</div>
          <form><textarea id="answer-edit">old answer</textarea><button data-testid="send-button" type="button">Send</button></form>
        </div></article>
      </div>
      <form id="composer-form"><textarea data-id="root"></textarea>
      <button data-testid="send-button" type="button" disabled>Send</button></form>`
    const box = document.querySelector('#composer-form textarea') as HTMLTextAreaElement
    const boxSend = document.querySelector('#composer-form [data-testid="send-button"]') as HTMLButtonElement
    const answerEdit = document.getElementById('answer-edit') as HTMLTextAreaElement
    const canvas = document.querySelector('.ProseMirror') as HTMLElement
    let wrongSend = false
    document.querySelector('#thread [data-testid="send-button"]')!.addEventListener('click', () => (wrongSend = true))
    box.addEventListener('input', () => (boxSend.disabled = !box.value.trim()))
    let typed = ''
    boxSend.addEventListener('click', () => {
      typed = box.value
      box.value = ''
      const user = document.createElement('div')
      user.setAttribute('data-message-author-role', 'user')
      user.textContent = typed
      document.getElementById('thread')!.appendChild(user)
      setTimeout(() => {
        const reply = document.createElement('div')
        reply.setAttribute('data-message-author-role', 'assistant')
        reply.innerHTML = '<pre><code>{"headline":"ok"}</code></pre>'
        document.getElementById('thread')!.appendChild(reply)
      }, 200)
    })
    const answered = await askChatGpt('Company: Liftoff\nJob description: React', 30_000)
    expect(typed.includes('Job description: React'), 'the job description is typed into the message box')
    expect(answerEdit.value === 'old answer' && canvas.textContent === 'Old CV text in a canvas', 'the last answer (canvas, edit box) is left untouched')
    expect(!wrongSend, "the answer's own Send button is not pressed")
    expect(answered.reply === '{"headline":"ok"}', 'and the reply is read as usual')
  }

  const plain = document.createElement('div')
  plain.textContent = 'Just text {"a":1}'
  expect(replyText(plain) === 'Just text {"a":1}', 'a reply without a code block is read as text')

  // No message box and a login button: a clear "log in" error.
  app.innerHTML = '<button data-testid="login-button">Log in</button>'
  const originalNow = Date.now
  let offset = 0
  Date.now = () => originalNow() + offset
  setTimeout(() => (offset = 60_000), 50)
  let loginError = ''
  await askChatGpt('x', 30_000).catch((error: Error) => (loginError = error.message))
  Date.now = originalNow
  expect(/not logged in in this Chrome profile/.test(loginError), 'a logged-out page says to log in')
  expect(offset === 0 || Date.now() - started < 60_000, 'the login page is reported at once, not after waiting')
}

console.log('\n--- Which file is the CV -----------------------------------------\n')

{
  const { pickResumeFile } = await import('../extension/src/content/chatgpt/chatgpt-runner.ts')
  const chat = [{ name: 'Agamyrat_Akmyradov_Ayble_Senior_Software_Engineer_CV.docx' }, { name: 'Agamyrat_Akmyradov_Ayble_Cover_Letter.docx' }]
  expect(pickResumeFile(chat)?.name.endsWith('_CV.docx') === true, 'the CV is chosen, not the cover letter listed after it')
  expect(
    pickResumeFile([{ name: 'Ayble_CV.docx' }, { name: 'Ayble_CV.pdf' }])?.name === 'Ayble_CV.pdf',
    'PDF preferred over Word when both exist',
  )
  expect(pickResumeFile([{ name: 'Cover_Letter.pdf' }]) === null, 'only a cover letter: no CV')
  const { pickCoverLetterFile } = await import('../extension/src/content/chatgpt/chatgpt-runner.ts')
  expect(
    pickCoverLetterFile([{ name: 'JA-pwnefv_Ayble_Tailored_CV.pdf' }, { name: 'JA-pwnefv_Ayble_Cover_Letter.pdf' }])?.name ===
      'JA-pwnefv_Ayble_Cover_Letter.pdf',
    'the cover letter in the same answer is found',
  )
  expect(pickCoverLetterFile([{ name: 'Ayble_CV.pdf' }]) === null, 'no cover letter in the answer: none')

  const { isResumeDownloadFor } = await import('../extension/src/sidepanel/lib/gpt-resume.ts')
  const dl = 'C:\\Users\\Administrator\\Downloads\\'
  expect(isResumeDownloadFor(`${dl}Agamyrat_Akmyradov_Ayble_Senior_Software_Engineer_CV.docx`, 'ayble'), 'downloaded CV matched by company')
  expect(isResumeDownloadFor(`${dl}Agamyrat_Ayble_CV.pdf`, 'Ayble Health, Inc.'), 'company with suffixes still matches')
  expect(!isResumeDownloadFor(`${dl}Agamyrat_Akmyradov_Ayble_Cover_Letter.docx`, 'ayble'), 'the cover letter is not taken as the CV')
  expect(!isResumeDownloadFor(`${dl}Agamyrat_Acme_CV.docx`, 'ayble'), 'another company\'s CV is ignored')
  expect(!isResumeDownloadFor(`${dl}JobApply\\ayble_Senior_Software_Engineer\\ayble_Senior_Software_Engineer_Resume.pdf`, 'ayble'), 'the extension\'s own saved copy is ignored')
  expect(!isResumeDownloadFor(`${dl}ayble_photo.jpg`, 'ayble'), 'non-document files are ignored')
}

console.log('\n--- Cover letter text from a PDF --------------------------------\n')

{
  // A real PDF (rendered by the extension's own letter renderer), read with pdf.js.
  const { renderLetterPdf } = await import('../extension/src/resume/pdf.ts')
  const { paragraphsFromTextItems } = await import('../extension/src/sidepanel/lib/document-text.ts')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const letter = [
    'Dear Hiring Team,',
    'Making digestive healthcare accessible and affordable is a difficult engineering challenge, especially when the platform needs to support reliable patient care, connect different data sources, and use AI without compromising quality.',
    'I would love to speak with your team about the technical roadmap. Thank you for considering my application.',
  ].join('\n\n')
  const bytes = await renderLetterPdf(letter, { name: 'Agamyrat Akmyradov', contact: 'Bucharest' }, 'Cover letter')
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false }).promise
  const pages = []
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    pages.push(content.items.filter((item: object) => 'str' in item) as never[])
  }
  const text = paragraphsFromTextItems(pages)
  const paragraphs = text.split('\n\n')
  expect(text.includes('Making digestive healthcare accessible and affordable is a difficult engineering challenge'), 'wrapped lines are joined back into one paragraph')
  expect(paragraphs.some((p) => p.startsWith('I would love to speak')) && paragraphs.some((p) => p === 'Dear Hiring Team,'), 'paragraphs stay separate')
  console.log(`      (${paragraphs.length} paragraphs read)`)
}

console.log('\n--- Written questions in one message -----------------------------\n')

{
  const { writtenQuestions, questionsMessage, parseNumberedAnswers } = await import('../extension/src/sidepanel/lib/batch-answers.ts')
  const { DEFAULT_PREFERENCES } = await import('../extension/src/shared/constants/defaults.ts')
  const field = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
    field: { id, label, type: 'textarea', category: 'AI_GENERATED', required: true, value: '', ...extra },
  })
  const session = {
    id: 's1',
    company: 'Ayble Health',
    position: 'Senior Software Engineer',
    lastReport: {
      url: 'https://jobs.ashbyhq.com/x',
      ask: [
        field('q1', 'What makes you interested in digestive health? *', { maxLength: 500 }),
        field('q2', 'Describe a system you built end to end.'),
        field('sel', 'Are you authorized to work in the US?', { type: 'select', category: 'PROFILE' }),
        field('radio', 'Willing to relocate?', { type: 'text', widget: 'radiogroup' }),
        field('cl', 'Cover letter', { canonicalField: 'coverLetter' }),
        field('done', 'Already answered', { value: 'yes' }),
      ],
      skipped: [field('q3', 'Anything else we should know?', { type: 'text', required: false })],
    },
  } as never

  const picked = writtenQuestions(session).map((f: { id: string }) => f.id)
  expect(JSON.stringify(picked) === JSON.stringify(['q1', 'q2', 'q3']), `only open written questions are sent (${picked.join(', ')})`)

  const message = questionsMessage(session, { ...DEFAULT_PREFERENCES }, writtenQuestions(session))
  expect(message.includes('Senior Software Engineer role at Ayble Health'), 'the message names the role and company')
  expect(message.includes('[1] What makes you interested in digestive health? (max 500 characters)'), 'numbered, required "*" dropped, length limit given')
  expect(message.includes('[3] Anything else we should know?') && !/resume|job description:/i.test(message), 'questions only - no CV or job description')

  const questions = ['What makes you interested in digestive health?', 'Describe a system you built end to end.', 'Anything else?']
  const bracketed = parseNumberedAnswers(
    'Sure!\n\n**[1]** My father lived with IBS, so this is personal.\n\n[2] I built a payments service:\n1. design\n2. rollout\n\n\\[3\\] No.',
    questions,
  )
  expect(bracketed.get(1) === 'My father lived with IBS, so this is personal.', 'bold [1] parsed, preamble ignored')
  expect(bracketed.get(2) === 'I built a payments service:\n1. design\n2. rollout', 'a numbered list inside an answer stays in it')
  expect(bracketed.get(3) === 'No.', 'escaped \\[3\\] parsed')
  const plainList = parseNumberedAnswers('1. Because...\n2) A booking API.\n3. Nothing else.', questions)
  expect(plainList.size === 3 && plainList.get(2) === 'A booking API.', 'plain "1." / "2)" numbering also parsed')
  const echoed = parseNumberedAnswers('[1] What makes you interested in digestive health?\nIt affects millions of people.', questions)
  expect(echoed.get(1) === 'It affects millions of people.', 'a repeated question line is dropped from the answer')
}

console.log('\n--- Claude links ------------------------------------------------\n')

{
  const { chatSite, isChatLink, isProjectLink, parseChatGptProjectUrl, checkChatGptLink } = await import(
    '../extension/src/ai/chatgpt-project.provider.ts'
  )
  const claudeChat = 'https://claude.ai/chat/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'
  expect(parseChatGptProjectUrl(claudeChat) === claudeChat && chatSite(claudeChat) === 'claude', 'Claude chat link accepted')
  expect(isChatLink(claudeChat), 'Claude chat link recognised as a chat')
  expect(isProjectLink('https://claude.ai/project/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0'), 'Claude project link recognised')
  expect(Boolean(checkChatGptLink('https://claude.ai/share/abc').error), 'Claude share link refused')
  expect(!isChatLink('https://chatgpt.com/g/g-p-abc/project'), 'a ChatGPT project slug ending in "c" is not taken as a chat')
}

console.log('\n--- ChatGPT tab reuse ------------------------------------------\n')

{
  const { ChatGptProjectProvider } = await import('../extension/src/ai/chatgpt-project.provider.ts')
  const { preferencesSlot } = await import('../extension/src/storage/settings.ts')
  type FakeTab = { id: number; url: string; status: string; active: boolean; discarded?: boolean }
  let tabs: FakeTab[] = []
  let nextId = 100
  const asked: number[] = []
  const chromeMock = g.chrome as Record<string, unknown>
  chromeMock.tabs = {
    query: async (info: { url?: string[]; active?: boolean }) =>
      info.active ? tabs.filter((t) => t.active) : tabs.filter((t) => /chatgpt\.com/.test(t.url)),
    create: async ({ url }: { url: string }) => {
      const tab = { id: nextId++, url, status: 'complete', active: false }
      tabs.push(tab)
      return tab
    },
    get: async (id: number) => tabs.find((t) => t.id === id) ?? Promise.reject(new Error('no tab')),
    update: async (id: number, props: { url?: string }) => {
      const tab = tabs.find((t) => t.id === id)!
      if (props.url) tab.url = props.url
      return tab
    },
    reload: async () => {},
    remove: async (id: number) => void (tabs = tabs.filter((t) => t.id !== id)),
    sendMessage: async (id: number, message: { type: string }) => {
      if (message.type === 'content/chatgptAsk') asked.push(id)
      return { ok: true, data: message.type === 'content/chatgptAsk' ? { reply: '{"edits":[]}' } : { ready: true, url: '' } }
    },
  }

  const chat = 'https://chatgpt.com/g/g-p-6ad0bc5fe89c-job-application/c/6ad0bcd8-db1c-83e8-b7fe-798889fedf60'
  await preferencesSlot.set({ ...(await preferencesSlot.get()), tailorVia: 'chatgpt-project', chatgptProjectUrl: chat })
  tabs = [
    { id: 1, url: 'https://jobs.ashbyhq.com/ayble/1', status: 'complete', active: true },
    { id: 2, url: 'https://chatgpt.com/c/11111111-other-chat', status: 'complete', active: false },
    { id: 3, url: `${chat}?model=x`, status: 'complete', active: false },
  ]
  const provider = new ChatGptProjectProvider()
  await provider.complete('job one')
  expect(asked[0] === 3 && tabs.length === 3, 'an open tab on the chat is reused - no new tab')

  tabs = tabs.filter((t) => t.id !== 3)
  await provider.complete('job two')
  const opened = tabs.find((t) => t.url === chat)
  expect(asked[1] === opened?.id && asked[1] !== 2, 'no tab on the chat: one is opened (another chat is never taken over)')
  await provider.complete('job three')
  expect(asked[2] === opened?.id && tabs.length === 3, 'the tab it opened stays open and is reused next time')

  // Written answers: ChatGPT too, but never in the tailoring chat.
  const { getProviderFor } = await import('../extension/src/ai/index.ts')
  const answers = await getProviderFor('answer:field-7')
  expect(answers.id === 'chatgpt-answers', 'written answers go to ChatGPT (no Gemini, no API key)')
  expect((await getProviderFor('coverLetter')).id === 'chatgpt-answers', 'cover letters go to ChatGPT too')
  expect((await getProviderFor('resume')).id === 'chatgpt-project', 'tailoring still uses the tailoring chat')

  // No answers chat yet: a clear message, nothing typed anywhere.
  let noLink = ''
  await answers.complete!('Why us?').catch((error: Error) => (noLink = error.message))
  expect(/No answers chat yet/.test(noLink), 'answers need the answers chat link (never a chat per answer)')

  const answersChat = 'https://chatgpt.com/c/7aa11111-2222-4333-8444-555566667777'
  await preferencesSlot.set({ ...(await preferencesSlot.get()), chatgptAnswersUrl: answersChat })
  const before = tabs.length
  asked.length = 0
  // Two drafts pressed together take turns rather than typing into one tab at once.
  let active = 0
  let overlapped = false
  const send = (chromeMock.tabs as { sendMessage: (id: number, m: { type: string }) => Promise<unknown> }).sendMessage
  ;(chromeMock.tabs as Record<string, unknown>).sendMessage = async (id: number, m: { type: string }) => {
    if (m.type !== 'content/chatgptAsk') return send(id, m)
    active += 1
    if (active > 1) overlapped = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    active -= 1
    return send(id, m)
  }
  await Promise.all([answers.complete!('Why us?'), answers.complete!('Describe a project.')])
  const answerTab = tabs.find((t) => t.url === answersChat)
  expect(Boolean(answerTab) && tabs.length === before + 1, 'answers go to the one answers chat, separate from the tailoring chat')
  expect(asked.length === 2 && asked.every((id) => id === answerTab?.id), 'the same answers chat tab is reused')
  expect(!asked.includes(opened!.id), 'the tailoring chat tab is never used for answers')
  expect(!overlapped, 'one ChatGPT request at a time')

  // Tailoring files: answer without files -> click Download -> else ask once more.
  const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4 ${text}`)
  const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  let scenario: 'click' | 'nudge' | 'never' = 'click'
  const prompts: string[] = []
  let clickRequests = 0
  const downloads: chrome.downloads.DownloadItem[] = []
  const createdListeners: ((item: chrome.downloads.DownloadItem) => void)[] = []
  chromeMock.downloads = {
    onCreated: {
      addListener: (fn: (item: chrome.downloads.DownloadItem) => void) => createdListeners.push(fn),
      removeListener: (fn: (item: chrome.downloads.DownloadItem) => void) => createdListeners.splice(createdListeners.indexOf(fn), 1),
    },
    search: async () => downloads,
  }
  ;(chromeMock.extension as unknown) = { isAllowedFileSchemeAccess: (cb: (ok: boolean) => void) => cb(false) }
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    if (String(url).startsWith('https://files.example/')) return new Response(pdf(String(url)))
    return realFetch(url)
  }) as typeof fetch
  ;(chromeMock.tabs as Record<string, unknown>).sendMessage = async (_id: number, m: { type: string; payload?: { prompt?: string } }) => {
    if (m.type === 'content/chatgptAsk') {
      prompts.push(m.payload?.prompt ?? '')
      const second = prompts.length >= 2
      const withFile = scenario === 'nudge' && second
      return {
        ok: true,
        data: {
          reply: '<box><row>**1. Tailored CV**</row></box>',
          ref: `JA-test${prompts.length}`,
          ...(withFile ? { file: { name: 'CV.pdf', base64: toBase64(pdf('cv')) }, coverLetter: { name: 'Cover_Letter.pdf', base64: toBase64(pdf('cl')) } } : {}),
        },
      }
    }
    if (m.type === 'content/chatClickDownloads') {
      clickRequests++
      if (scenario !== 'click') return { ok: true, data: { clicked: 0 } }
      for (const [i, name] of ['Makersite CV.pdf', 'Makersite Cover Letter.pdf'].entries()) {
        const item = { id: 900 + i, filename: `C:\\Users\\me\\Downloads\\${name}`, state: 'complete', finalUrl: `https://files.example/${i}`, url: '', startTime: new Date().toISOString() } as chrome.downloads.DownloadItem
        downloads.push(item)
        createdListeners.forEach((fn) => fn(item))
      }
      return { ok: true, data: { clicked: 2 } }
    }
    return { ok: true, data: { ready: true, url: '' } }
  }

  const tailor = new ChatGptProjectProvider('tailor')
  const clicked = await tailor.createFile('job')
  expect(clickRequests === 1 && prompts.length === 1, 'answer without attached files: its Download links are clicked (no second message)')
  expect(clicked.name === 'Makersite CV.pdf' && clicked.coverLetter?.name === 'Makersite Cover Letter.pdf', 'CV and cover letter collected from the downloads')

  scenario = 'nudge'
  prompts.length = 0
  const nudged = await tailor.createFile('job')
  expect(prompts.length === 2 && /create the tailored CV and the cover letter/.test(prompts[1]!), 'no files at all: the chat is asked once more to create them')
  expect(nudged.name === 'CV.pdf' && nudged.coverLetter?.name === 'Cover_Letter.pdf', 'the files from the second answer are used')

  scenario = 'never'
  prompts.length = 0
  let failure = ''
  await tailor.createFile('job').catch((error: Error) => (failure = error.message))
  expect(prompts.length === 2, 'asked at most once more - never a loop')
  expect(/did not create a CV file/.test(failure) && !/<box|<row|\*\*/.test(failure), `the error is readable, without markup (${failure})`)
  globalThis.fetch = realFetch
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} check(s) failed.\n`)
  process.exit(1)
}
console.log('All link checks passed.\n')
