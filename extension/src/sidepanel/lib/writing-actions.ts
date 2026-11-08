/**
 * Resume / cover letter actions shared by the manual buttons and autopilot, so both
 * paths save the same files and record the same state.
 */

import { generateDocx, generatePdf, type GeneratedFile } from '@/resume/resume-generator'
import { generateLetterPdf, withLetterChecks } from '@/resume/cover-letter'
import { bytesToBase64 } from '@/shared/utils/bytes'
import { sendMessage } from '@/shared/utils/messaging'
import { saveFile } from './files'
import { fileOwnerName } from '@/storage/applicant-profile'
import { jobFolderName } from '@/shared/utils/format'
import { gptLetterFile, gptResumeFile } from './gpt-resume'
import type { ApplicationSession } from '@/shared/types/application'
import type { CoverLetterState } from '@/shared/types/resume'
import type { MasterResumeMeta } from '@/shared/types/settings'
import type { WritingPatch } from '@/shared/types/messages'

type Update = (patch: WritingPatch) => Promise<void>

/**
 * The company and position name every file and folder. Without them a file would
 * be saved as "_Resume.docx" in an "Unnamed_Job" folder, and could overwrite another
 * job's - so nothing is saved until both are known.
 */
export function requireJobNames(session: ApplicationSession): void {
  if (!session.company.trim()) {
    throw new Error('The company name is unknown. Press Edit next to the job title above, enter it, then try again.')
  }
  if (!session.position.trim()) {
    throw new Error('The position is unknown. Press Edit next to the job title above, enter it, then try again.')
  }
}

/** Saves the tailored .docx (when the master is one) and .pdf, and marks the resume approved. */
export async function approveAndSaveResume(
  session: ApplicationSession,
  master: MasterResumeMeta,
  update: Update,
): Promise<{ docxDownloadId: number | null }> {
  const resume = session.resume
  if (!resume) throw new Error('There is no tailored resume to save.')
  requireJobNames(session)

  const owner = await fileOwnerName()
  const docx = generateDocx(master, resume.edits, owner)
  const pdf = await generatePdf(master, resume.edits, owner)
  const docxDownloadId = docx ? await saveFile(docx, session) : null
  await saveFile(pdf, session)

  await update({
    resume: {
      ...resume,
      approved: true,
      ...(docx ? { docxFileName: docx.fileName } : {}),
      pdfFileName: pdf.fileName,
    },
    resumeApproved: true,
    // The Resume column records what employers receive: the PDF that gets uploaded, in its job's folder.
    tailoredResume: `${jobFolderName(session.company, session.position)}/${pdf.fileName}`,
  })
  return { docxDownloadId }
}

/**
 * The resume file to upload into a given field: always the PDF. The .docx is only
 * used when the field explicitly refuses PDF (its `accept` lists Word types and no
 * PDF) - uploading a PDF there would simply be rejected.
 */
export async function resumeFileFor(
  session: ApplicationSession,
  master: MasterResumeMeta | null,
  accept: string | undefined,
): Promise<GeneratedFile> {
  // ChatGPT created the PDF itself: upload exactly that file.
  if (session.resume?.source === 'gpt-file') return gptResumeFile(session)
  if (!master) throw new Error('Add your master resume in Settings > Resume.')
  const edits = session.resume?.edits ?? []
  const owner = await fileOwnerName()
  if (refusesPdf(accept)) {
    const docx = generateDocx(master, edits, owner)
    if (docx) return docx
  }
  return generatePdf(master, edits, owner)
}

function refusesPdf(accept: string | undefined): boolean {
  if (!accept?.trim()) return false
  const types = accept.toLowerCase()
  const takesWord = /\.docx?\b|wordprocessingml|msword/.test(types)
  return takesWord && !/pdf/.test(types)
}

export async function approveLetter(
  session: ApplicationSession,
  letter: CoverLetterState,
  update: Update,
  patch: Partial<CoverLetterState> = {},
): Promise<CoverLetterState> {
  const next = await withLetterChecks(session, { ...letter, ...patch, approved: true })
  await update({ coverLetter: next })
  return next
}

/** The cover letter file to upload: ChatGPT's own file when it made one, else rendered from the text. */
export async function letterFileFor(session: ApplicationSession): Promise<GeneratedFile> {
  const letter = session.coverLetter
  if (!letter) throw new Error('There is no cover letter yet.')
  if (letter.source === 'gpt-file') return gptLetterFile(session)
  return generateLetterPdf(session, letter.text)
}

export async function saveLetterPdf(
  session: ApplicationSession,
  text: string,
): Promise<GeneratedFile> {
  requireJobNames(session)
  const file = await generateLetterPdf(session, text)
  await saveFile(file, session)
  return file
}

/** Puts a generated file into an upload field on the job tab. */
export async function attachToField(
  sessionId: string,
  fieldId: string,
  file: GeneratedFile,
): Promise<{ attached: boolean; error?: string }> {
  return sendMessage('page/attachFile', {
    sessionId,
    fieldId,
    fileName: file.fileName,
    mime: file.mime,
    base64: bytesToBase64(file.bytes),
  })
}

/** Upload fields on the current page scan that are still empty. */
export function emptyUploadFields(session: ApplicationSession) {
  const report = session.lastReport
  if (!report) return []
  return [...report.ask, ...report.skipped]
    .map((plan) => plan.field)
    .filter((field) => field.type === 'file' && !field.value)
}

export { isCoverLetterUpload, isResumeUpload } from '@/shared/utils/presubmit'
