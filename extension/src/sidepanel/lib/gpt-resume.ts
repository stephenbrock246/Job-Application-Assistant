/**
 * "ChatGPT creates the PDF" tailoring.
 *
 *   job description -> the user's ChatGPT chat (which already knows their resume
 *   and tailoring instructions) -> ChatGPT creates a PDF -> the extension saves it
 *   as Company_Position_Resume.pdf in the job folder and uploads it.
 *
 * The file's bytes are kept in storage per application, so the upload step sends
 * exactly the PDF ChatGPT made. There are no paragraph edits and no fact check:
 * the content is what the user's chat produced.
 */

import { ChatGptProjectProvider } from '@/ai/chatgpt-project.provider'
import { throwIfCancelled } from '@/ai/retry'
import { defineSlot } from '@/storage/base'
import { base64ToBytes, bytesToBase64 } from '@/shared/utils/bytes'
import { coverLetterFileName, jobFolderName, resumeFileName } from '@/shared/utils/format'
import { fileOwnerName } from '@/storage/applicant-profile'
import { documentText } from './document-text'
import { saveFile } from './files'
import { readLocalFile } from '@/shared/utils/local-file'
import { requireJobNames } from './writing-actions'
import type { GeneratedFile } from '@/resume/resume-generator'
import type { ApplicationSession } from '@/shared/types/application'
import type { Preferences } from '@/shared/types/settings'
import type { WritingPatch } from '@/shared/types/messages'

interface StoredFile {
  fileName: string
  mime?: string
  base64: string
  savedAt: number
}

/** Created files by application id ("{id}" CV, "{id}:letter" cover letter); only the most recent are kept. */
const gptResumeSlot = defineSlot<Record<string, StoredFile>>('gptResumeFiles', () => ({}))
const KEEP = 60

/** The message to the chat: the user's line, then the job. Never the tailoring prompt. */
export function gptFileMessage(session: ApplicationSession, prefs: Preferences): string {
  const jd = session.jobInfo?.description.trim() ?? ''
  if (!jd) throw new Error('Extract the job description first (Scan page above), or paste it.')
  return [
    prefs.chatgptMessage.trim(),
    `Company: ${session.company.trim()}\nPosition: ${session.position.trim()}`,
    `Job description:\n${jd}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Has ChatGPT create the PDF, saves it in the job folder and records it on the
 * application as an approved resume.
 */
export async function tailorWithGptFile(
  session: ApplicationSession,
  prefs: Preferences,
  update: (patch: WritingPatch) => Promise<void>,
  options: { signal?: AbortSignal; report?: (message: string) => void } = {},
): Promise<{ fileName: string; createdAs: string; letterFileName: string | null }> {
  requireJobNames(session)
  const message = gptFileMessage(session, prefs)
  options.report?.('ChatGPT is creating your CV...')
  const askedAt = Date.now()

  let created: { name: string; bytes: Uint8Array; coverLetter?: { name: string; bytes: Uint8Array } | null }
  try {
    created = await new ChatGptProjectProvider().createFile(message, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.report ? { onProgress: options.report } : {}),
    })
  } catch (error) {
    throwIfCancelled(options.signal)
    // ChatGPT answered, but its file could not be fetched: one it was downloaded
    // into Downloads since we asked (by the chat, or by the user) is just as good.
    const downloaded = await findResumeInDownloads(session, { since: askedAt }).catch(() => null)
    if (!downloaded) throw error
    created = downloaded
  }
  throwIfCancelled(options.signal)
  options.report?.('Saving your CV...')
  const resume = await adoptResumeFile(session, created, update, `Created by ChatGPT as "${created.name}".`)

  // A cover letter in the same answer: saved, uploaded and pasted like any approved letter.
  let letterFileName: string | null = null
  if (created.coverLetter) {
    options.report?.('Saving the cover letter...')
    letterFileName = await adoptLetterFile(session, created.coverLetter, update).catch(() => null)
  }
  return { ...resume, letterFileName }
}

/**
 * Records a cover letter file ChatGPT created: saved as
 * {Company}_{Position}_Cover_Letter.{pdf|docx}, kept for upload, and its text read
 * for the form's cover letter box.
 */
export async function adoptLetterFile(
  session: ApplicationSession,
  source: { name: string; bytes: Uint8Array },
  update: (patch: WritingPatch) => Promise<void>,
): Promise<string> {
  const kind = fileKind(source.bytes)
  if (!kind) throw new Error(`"${source.name}" is not a PDF or Word file.`)
  const file: GeneratedFile = {
    fileName: coverLetterFileName(await fileOwnerName(), kind.ext),
    bytes: source.bytes,
    mime: kind.mime,
  }
  await saveFile(file, session)
  await store(`${session.id}:letter`, file)

  const text = await documentText(source.bytes, kind.ext).catch(() => '')
  await update({
    coverLetter: {
      source: 'gpt-file',
      generatedBy: { model: 'ChatGPT', fallback: false },
      text,
      warnings: text
        ? []
        : [{ message: 'The text could not be read from the file, so it cannot be pasted into a text box. The file itself is uploaded.' }],
      generatedAt: Date.now(),
      ...(kind.ext === 'pdf' ? { pdfFileName: file.fileName } : { docxFileName: file.fileName }),
      approved: true,
    },
  })
  return file.fileName
}

/** The cover letter file ChatGPT created for this application. */
export async function gptLetterFile(session: ApplicationSession): Promise<GeneratedFile> {
  const stored = (await gptResumeSlot.get())[`${session.id}:letter`]
  if (!stored) throw new Error('The cover letter file is no longer stored. Press "Create again" in the Resume section.')
  return { fileName: stored.fileName, bytes: base64ToBytes(stored.base64), mime: stored.mime ?? 'application/pdf' }
}

async function store(key: string, file: GeneratedFile): Promise<void> {
  await gptResumeSlot.update((all) => {
    const next = { ...all, [key]: { fileName: file.fileName, mime: file.mime, base64: bytesToBase64(file.bytes), savedAt: Date.now() } }
    const ids = Object.keys(next).sort((a, b) => next[b]!.savedAt - next[a]!.savedAt)
    for (const id of ids.slice(KEEP)) delete next[id]
    return next
  })
}

/**
 * Records a CV file (from ChatGPT or Downloads) as this application's approved
 * resume: saved as {Company}_{Position}_Resume.{pdf|docx} in the job folder and
 * kept for the upload step.
 */
export async function adoptResumeFile(
  session: ApplicationSession,
  source: { name: string; bytes: Uint8Array },
  update: (patch: WritingPatch) => Promise<void>,
  note: string,
): Promise<{ fileName: string; createdAs: string }> {
  requireJobNames(session)
  const kind = fileKind(source.bytes)
  if (!kind) {
    throw new Error(`"${source.name}" is not a PDF or Word file. Ask the chat to create the CV as a PDF or .docx file.`)
  }

  const file: GeneratedFile = {
    fileName: resumeFileName(await fileOwnerName(), kind.ext),
    bytes: source.bytes,
    mime: kind.mime,
  }
  await saveFile(file, session)
  await store(session.id, file)

  await update({
    resume: {
      source: 'gpt-file',
      generatedBy: { model: 'ChatGPT', fallback: false },
      promptProfileId: 'chatgpt-chat',
      promptProfileName: 'Your ChatGPT chat',
      edits: [],
      changeNotes: [note],
      warnings: [],
      masterFileName: '',
      masterUploadedAt: 0,
      generatedAt: Date.now(),
      ...(kind.ext === 'pdf' ? { pdfFileName: file.fileName } : { docxFileName: file.fileName }),
      approved: true,
    },
    resumeApproved: true,
    tailoredResume: `${jobFolderName(session.company, session.position)}/${file.fileName}`,
    // The resume step is settled, and a resume uploaded before must be uploaded again.
    autopilot: {
      ...(session.autopilot ?? {}),
      resume: { state: 'done', note: `${note} Saved as ${file.fileName}.`, at: Date.now() },
      attached: Object.fromEntries(
        Object.entries(session.autopilot?.attached ?? {}).filter(([, entry]) => !/(^|_)(Resume|CV|Cover_Letter)\.(pdf|docx)$|^the cover letter text$/i.test(entry.fileName)),
      ),
    },
  })
  return { fileName: file.fileName, createdAs: source.name }
}

/** The CV file kept for this application, for upload or preview. */
export async function gptResumeFile(session: ApplicationSession): Promise<GeneratedFile> {
  const stored = (await gptResumeSlot.get())[session.id]
  if (!stored) throw new Error('The CV file is no longer stored. Press "Create again", or "Use CV from Downloads".')
  return { fileName: stored.fileName, bytes: base64ToBytes(stored.base64), mime: stored.mime ?? 'application/pdf' }
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/** PDF or .docx, from the bytes themselves (names and server types can be wrong). */
function fileKind(bytes: Uint8Array): { ext: 'pdf' | 'docx'; mime: string } | null {
  // "%PDF" may follow a few bytes of junk; PDF readers accept it within the first 1 KB.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  if (head.includes('%PDF-')) return { ext: 'pdf', mime: 'application/pdf' }
  // A .docx is a zip holding word/document.xml.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && new TextDecoder('latin1').decode(bytes).includes('word/')) {
    return { ext: 'docx', mime: DOCX_MIME }
  }
  return null
}

// ---------------------------------------------------------------------------
// Downloads folder

/** Words of the company name that identify it in a file name ("Ayble Health, Inc." -> ayble, health). */
function companyKeys(company: string): string[] {
  const words = company
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !['inc', 'llc', 'ltd', 'corp', 'the', 'company', 'group', 'gmbh'].includes(w))
  return words.length ? words : [company.toLowerCase().replace(/[^a-z0-9]/g, '')]
}

/**
 * Is this downloaded file a CV for this company? Its name has the company (first
 * significant word), it is a PDF or Word file, it is not a cover letter, and it is
 * not one of the extension's own saved files.
 */
export function isResumeDownloadFor(path: string, company: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (!/\.(pdf|docx)$/.test(name)) return false
  if (/cover|letter|motivation/.test(name)) return false
  if (/[\\/]jobapply[\\/]/i.test(path)) return false
  const flat = name.replace(/[^a-z0-9]/g, '')
  return flat.includes(companyKeys(company)[0]!)
}

/**
 * The newest CV for this company in Chrome's downloads (complete, still on disk).
 * Reads the file itself, which needs "Allow access to file URLs" for the extension.
 */
export async function findResumeInDownloads(
  session: ApplicationSession,
  options: { since?: number } = {},
): Promise<{ name: string; bytes: Uint8Array; downloadedAt: number } | null> {
  const items = await chrome.downloads.search({ state: 'complete', exists: true, orderBy: ['-startTime'], limit: 200 })
  const match = items.find(
    (item) =>
      isResumeDownloadFor(item.filename, session.company) &&
      (!options.since || Date.parse(item.endTime ?? item.startTime) >= options.since - 5_000),
  )
  if (!match) return null
  const bytes = await readLocalFile(match.filename)
  return { name: match.filename.split(/[\\/]/).pop() ?? match.filename, bytes, downloadedAt: Date.parse(match.startTime) }
}
