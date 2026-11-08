# JobApply Assistant

A Chrome Side Panel extension that helps you apply to jobs faster **without** taking the final
submission out of your hands.

It reads your job queue from a Google Sheet, opens each job while staying visible beside the page,
extracts the job description, and (in later phases) tailors your resume and assists with the
application form. A row is only ever marked **Applied** after you press **Done**.

---

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Extension foundation, Side Panel, Settings, storage | **Done** |
| 2 | Job source (CSV or Google Sheets), ready queue, Open/Apply, Done, status write-back | **Done** |
| 3 | Form scanner, field classification, autofill, missing-info UI | **Done** |
| 4 | Multi-page applications, page-change detection, session restore | **Done** |
| 5 | Resume tailoring, cover letters, drafted answers, AI handoff, .docx/PDF output | **Done** |
| 6 | Platform adapters (Greenhouse, Lever, Ashby, Workday, Indeed, LinkedIn) | Not started |

Phase 3+ surfaces are visible in the UI and clearly labelled as not yet wired up. Nothing fakes a
capability it does not have.

### What works today

- Read your job list from a **CSV file** (default, no accounts or setup) or a **Google Sheet**
  (optional, needs a Google Cloud OAuth client).
- Columns resolved **by header name**, never by column letter, with a mapping table in Settings.
- CSV import handles what real exports contain: UTF-8 BOM, CRLF or LF, comma/semicolon/tab
  delimiters, quoted fields with embedded commas and newlines, and a title row above the header.
- Missing `Applied Date` / `Resume` / `Other` columns are appended on import so write-back works.
- Ready queue showing only actionable rows (blank Status = Ready, plus In Progress).
- Open a job in a new tab with the panel still visible; Status flips to In Progress.
- Generic job-description extraction (JSON-LD → known ATS selectors → densest text block) with a
  reported confidence.
- **Done** → confirm → writes Status / Applied Date / Resume / Other to the correct row; the job
  leaves the queue. With a CSV, **Save** writes your original file in place where the browser allows
  it, and an unsaved-changes banner makes sure the working copy never silently drifts from the file.
- **Skip / Failed** → reason → writes Failed plus the reason into Other.
- Full applicant profile, saved default answers, prompt profiles, master resume text — all stored
  locally and ready for the later phases.
- Sessions persist, so closing Chrome mid-application does not lose your place.
- **Scan** any application page: normalises every control into a labelled, typed,
  required-flagged field, resolving labels from `label[for]`, wrapping labels, `aria-labelledby`,
  `aria-label`, fieldset legends, adjacent label markup, and finally placeholders.
- **Autofill** from your profile and saved answers, with a confidence gate — anything below 70%
  confidence is asked about rather than guessed.
- **Missing information** cards for every field the extension will not answer itself, each stating
  *why* it is asking, with "Save as default" where the field is genuinely reusable.
- Every write is verified by reading the DOM back; a value the page rejected is reported as needing
  your attention, not counted as filled.
- Click any field's arrow to jump to it on the page and have it highlighted.
- **Multi-page applications.** The panel's Next button finishes the current page (autofill), checks
  that no required field is still empty, clicks the page's Next/Continue, and then *verifies* the
  page actually changed before counting it as progress:
  - page changed → the new step is recorded and autofilled (Settings → General, on by default);
  - page stayed and shows errors → one automatic correct-and-retry (fill-empty-fields only), then
    the errors are listed with jump-to-field links;
  - nothing happened within 15 s → reported as such, never as success.
- Page changes are detected by what the page *asks* (a fingerprint of its questions and step
  heading), not by URL — so single-page-app flows that never change the URL work, filling a page
  never looks like leaving it, and a question revealed by a previous answer is "same page, updated".
- Going **Back** is recognised as returning to an earlier step, not counted as a new one.
- Moving through the form **by hand** is followed too: a MutationObserver in the job tab reports
  step changes and the panel rescans on its own. Full page loads are followed via the tab.
- A final **Submit / Apply** control is never clicked — refused at click time, not just hidden in
  the UI. A "thank you for applying" page only prompts you to press Done; it records nothing.
- **Session restore:** the session remembers its steps and the last application page URL. After a
  browser restart it re-attaches to a tab showing that page, or reopens it there.

- **Tailored resumes that keep your Word layout.** Upload your master `.docx`; tailoring rewrites
  paragraph *text* inside the original file. Styles, numbering, spacing, fonts, headers and images
  are untouched, and an unchanged bold label or italic date inside a rewritten line keeps its own
  formatting. The model may rewrite or remove paragraphs but never add them, and headings can never
  be removed.
- **Review before anything is saved.** Every changed paragraph is shown before/after, editable, and
  revertible. **Approve & save** writes `{Company}_{Position}_Resume.docx` plus an approximate
  `.pdf` to `Downloads/JobApply/`; the filename goes to the Resume column on Done.
- **Prompt profiles** per kind — resume tailoring and cover letter each have their own list and
  default. "Edit for this job" instructions apply to one job and never change a profile.
- **Cover letters** from their own prompt: edit, copy, *Insert into form* (only into a field
  classified as a cover letter), or save as `{Company}_{Position}_Cover_Letter.pdf`.
- **Drafted answers** for written questions ("Why this role?") from the Information Required card,
  respecting the field's character limit. Drafts land in the editor; you still press Save.
- **Fabrication check.** Generated text is compared against your master resume: numbers it never
  states, technologies that come from the job description but not your resume, and leftover
  `[Placeholders]` are flagged next to the text. Warnings never block — you know what is true.

### How the AI is used

- **Google Gemini (automatic, free tier).** Settings → AI → Google Gemini, paste a free key from
  aistudio.google.com (*Get API key*), *Test connection*. Default model `gemini-3.8-flash`. On the
  free tier Google may use prompts to improve its products, so email, phone and links are replaced
  with placeholders before sending and restored in the reply (switchable).
  Busy or rate-limited responses (408/429/5xx, dropped connections) are retried automatically at
  ~2s/4s/8s/16s/30s with jitter, showing "retrying (2/5)" in the panel; key or setup errors
  (400/401/403/404) are never retried. If the model keeps answering 503, one attempt is made on the
  fallback model (Settings → AI), and results show which model wrote them. A failed autopilot step
  keeps the application intact and offers **Retry**. One tailoring run per application at a time.
- **OpenAI API (automatic, paid).** Settings → AI → OpenAI API, paste an API key, pick a
  model (`gpt-6-sol` by default), *Test connection*. Uses the Responses API; billed per use by
  OpenAI, separately from ChatGPT Plus. The key is kept in memory until Chrome closes unless you
  tick *Remember on this computer* (then it is stored unencrypted in this browser profile — use a
  project key with a spending limit).
- **Copy/paste (Claude or ChatGPT).** The prompt is copied; you paste it into your logged-in chat
  and paste the reply back. Pasting the prompt itself back by mistake is detected and refused.
- **Resume tailoring in your ChatGPT chat (optional, resume only).** Settings → AI → *Tailor
  resume in my ChatGPT chat*: paste the chat's address-bar link (`https://chatgpt.com/…/c/…`; Share
  links are refused because they open a read-only copy; a project link also works and starts a new
  chat per job), Save, tick *Use it for resume tailoring*. For each job a background tab opens the
  chat, the resume's numbered paragraphs + job description are typed and sent with a short
  `(ref JA-…)` tag, the answer to that tagged message is read when ChatGPT finishes, applied to your `.docx`, fact-checked and saved like any other
  tailoring. A tab already open on that chat (any window) is reused; otherwise one is opened in the
  background and left open for the next job. Other ChatGPT tabs are never taken over.
  **What ChatGPT returns** (same card): *Changes to my Word resume* (above), or *ChatGPT creates the
  PDF itself* — only an optional line + company/position + job description is sent; when the answer
  finishes, the PDF it made (a `sandbox:/mnt/data/…` link or an attached file in the conversation
  record) is fetched with your login, checked to be a real PDF, saved as
  `Company_Position_Resume.pdf` in the job folder and uploaded to resume fields. No master resume
  or fact check in this mode; the bytes are kept per application (`gptResumeFiles`, last 30). Cover letters and answers keep the provider above. Selectors live in
  `content/chatgpt/chatgpt-runner.ts` if chatgpt.com changes its markup.

### Autopilot (with Gemini or the OpenAI API)

For each job you open: the resume is tailored as soon as the job description is extracted; a cover
letter is written only if the form asks for one (text field or upload); results that pass the fact
check with **no** warnings are approved and saved; approved files are attached to the form's
resume / cover-letter upload fields, and the upload is verified by reading the field back.
Anything with a warning stops and waits for you. Each step runs at most once per application.
Submitting and pressing Done are always yours. Every switch is in Settings → AI.

### What it deliberately does not do

- It does not submit. Ever.
- It cannot restore form *contents* a site discards — reopening a mid-flow URL shows whatever the
  site shows, and the tracker recognises that as returning to an earlier step.
- Uploads use standard file inputs. Sites with custom upload widgets may refuse a scripted file;
  the panel says so and the file is in `Downloads/JobApply/`.
- The PDF is approximate (standard fonts, simple layout). For an exact PDF, export the `.docx`.
- PDF masters are not text-extracted; upload the `.docx` (or paste text).

---

## Setup

### 1. Install and build

```bash
npm install
npm run build      # typecheck + production build into dist/
```

For development with hot reload:

```bash
npm run dev
```

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.

### 3. Import your job list

Open the side panel → **Settings → Job source** → **Import CSV file**.

`job-list-template.csv` in this repo is a ready-made starting point.

That is the whole setup. No account, no API key, no Google Cloud project.

Expected headers (spelling is flexible — see `shared/constants/sheet.ts` for accepted aliases):

| Date | Job Link | Company | Position | Status | Other | Applied Date | Resume |
| --- | --- | --- | --- | --- | --- | --- | --- |

Only **Job Link** and **Status** are required. The rest are optional, and the three write-back
columns are appended automatically if your file lacks them.

Status values: blank = *Ready to apply*, then `In Progress`, `Applied`, `Failed`, `Intro Call`,
`Interview`, `Offer`.

### How saving works

The extension holds a **working copy** of your CSV. Opening a job, pressing Done, or skipping one
updates that copy instantly — the file on disk changes when you save.

Saving tries three routes, best first:

1. **In place.** If Chrome granted write access when you imported, Save overwrites your original
   file with no dialog. Turn on *Save automatically after each change* and you never think about it.
2. **Save as.** You pick the location once; later saves overwrite that file directly.
3. **Download.** A normal download you replace your original with.

Which one applies is shown in Job source settings, and an unsaved-changes banner appears in the
panel whenever the copy is ahead of the file.

> Write permission on a file handle does not survive a browser restart, so after restarting Chrome
> the first save may ask you to re-grant access. The extension reports this rather than silently
> falling back.

### Google Sheet by link (no download, no Google Cloud)

1. In the sheet: **Share → General access → Anyone with the link → Viewer**.
2. **Settings → Job source → Google Sheet (paste link)**, paste the sheet's address (the tab in the
   link is the one read), **Connect**.

Every refresh reads the sheet live; nothing is downloaded. It is read-only: you keep updating the
sheet yourself. When you press Done or Skip, the queue updates at once and a *Sheet updates* card
lists what to type into the sheet (Copy gives a tab-separated line to paste at the Status cell).
Each note disappears once the sheet shows that status.

### Optional: Google Sheets with sign-in (writes back)

Switch the source in **Settings → Job source**. This path needs a Google Cloud project:

1. <https://console.cloud.google.com/> → create or pick a project.
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **OAuth consent screen** → External → add your own account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID** → type **Chrome Extension**, using the
   extension ID from `chrome://extensions`.
5. Put the client ID into `oauth2.client_id` in `extension/src/manifest.json`, rebuild, reload.

Until that is done the panel says "OAuth client ID is not configured" rather than failing silently.
The extension ID of an unpacked build derives from its absolute path, so it stays stable as long as
you do not move `dist/`.

---

## Project structure

```
extension/src/
├── sidepanel/          React side panel (components, pages, hooks, state)
├── autofill/           Pure planning layer: fields + profile -> fill / ask / skip
├── content/            Content script: adapters, scanner, autofill, validation, navigation
├── background/         Service worker: source I/O, tabs, session lifecycle
├── jobsource/          JobSource interface, CSV parser + source, Sheets source, row parser
├── google/             OAuth + Sheets client (used only by the Sheets source)
├── ai/                 AIProvider interface, registry, provider implementations
├── resume/             Parser, tailoring orchestration, PDF generation
├── storage/            Typed chrome.storage.local slots
└── shared/             types / constants / utils
```

### Design notes worth knowing before extending it

- **The side panel owns no authoritative state.** It mirrors the background worker and
  `chrome.storage`, and refreshes on broadcast. Two panels can never disagree.
- **The AI boundary is real.** Only files in `src/ai/` import a concrete provider. Everything else
  depends on the `AIProvider` interface, so swapping browser-session mode for an API key is a
  registry change.
- **Question categories drive behaviour, not labels.** `USER_CONFIRMATION_REQUIRED` fields (legal
  attestations, signatures, EEO/demographics) are structurally excluded from autofill in
  `canonical-fields.ts` — no confidence score can override that. The classifier applies that
  category as a *floor*: pattern-matched confirmation language wins over every other signal, and the
  planner's first rule refuses to produce a fill instruction for it.
- **Policy is separate from mechanism.** `autofill/planner.ts` is pure — fields in, decisions out,
  no DOM and no storage. The content script only scans and writes. All five autofill rules live in
  that one file, which is why they can be read and argued with in one sitting.
- **Row writes are verified.** Before writing Applied/Failed, the background re-reads the row's Job
  Link and refuses if it no longer matches the session. Rows move; the wrong job must never be
  marked applied.
- **The source is swappable.** The background worker knows only the `JobSource` interface, so CSV and
  Google Sheets share every line of queue, session and Done logic — and both funnel through the same
  `row-parser`, so a job means the same thing whichever produced it.
- **A CSV save never rewrites more than it must.** Only the header row (when columns are appended)
  and the rows you actually changed differ after a round trip. Preamble lines, short rows and quoting
  style are preserved. `npm run check:csv` asserts this record by record.
- **Done is the only path to Applied.** Nothing in the codebase infers a successful submission from a
  clicked Submit button.

---

## Privacy

Everything lives in `chrome.storage.local` in your browser profile: applicant details, saved answers,
prompt profiles, your master resume (the `.docx` itself), sessions, and the imported job list.
Nothing is sent anywhere by the extension; prompts reach an AI only when you paste them. With the CSV source nothing leaves
your machine at all.

Never stored: Google/Gmail passwords, ChatGPT/Claude passwords. Google sign-in (only if you choose
the Sheets source) is handled by Chrome's identity service, which holds the token. AI access uses the
browser session you are already logged into.

**Settings → General → Erase all local data** clears everything.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run build:only` | Build without typechecking |
| `npm run typecheck` | `tsc --noEmit` over extension source and config files |
| `npm run check` | Both checks below |
| `npm run check:scanner` | Runs the real scanner/classifier/autofill code against an HTML fixture in jsdom |
| `npm run check:csv` | Runs the real CSV parser/importer/writer/exporter over awkward real-world files |
| `npm run check:navigation` | Runs the real page-change detection, step tracking and Next handling against a multi-step SPA form in jsdom |
| `npm run check:ai` | Drives the Gemini provider against a scripted fake API: retry schedule, non-retryable errors, bounded attempts, fallback rules, and the one-run-at-a-time lock |
| `npm run check:resume` | Round-trips an awkward .docx through prompt → messy pasted reply → edits, and asserts formatting and untouched parts survive; checks the fabrication flags and PDF output |

### About `check:scanner`

The scanner is heuristic, so it gets a fixture. `scripts/fixtures/acme-application.html` is a
deliberately awkward application form — placeholder-only labels, Greenhouse-style adjacent label
divs, `aria-label` fields, radio groups in fieldsets, a prefilled field, hidden and disabled inputs,
a site search box, two legal attestations, and EEO questions.

The check asserts both halves of the contract: ordinary fields are recognised and filled with the
right values, **and** nothing protected is ever written — verified again after a live fill pass, not
just in the plan. If you change the classifier, run this first.
