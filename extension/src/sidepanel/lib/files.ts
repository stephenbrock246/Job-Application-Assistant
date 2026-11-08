/**
 * Saving and previewing generated files (spec sections 13-14).
 *
 * Files go to Downloads/JobApply/{Company}_{Position}/ via chrome.downloads - one
 * folder per job, so each application's resume and cover letter stay together and
 * never overwrite another job's - without a save dialog per file.
 */

import { jobFolderName } from '@/shared/utils/format'
import type { GeneratedFile } from '@/resume/resume-generator'

const ROOT = 'JobApply'

/** "JobApply/Stripe_Senior_Software_Engineer" - shown to the user as where files went. */
export function jobFolderPath(company: string, position: string): string {
  return `${ROOT}/${jobFolderName(company, position)}`
}

function blobUrl(file: GeneratedFile): string {
  // Copy into a fresh ArrayBuffer so the Blob never aliases a shared buffer.
  return URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mime }))
}

/** Saves the file into the job's folder; resolves with its download id once Chrome has accepted it. */
export async function saveFile(file: GeneratedFile, job: { company: string; position: string }): Promise<number> {
  const url = blobUrl(file)
  try {
    return await chrome.downloads.download({
      url,
      filename: `${jobFolderPath(job.company, job.position)}/${file.fileName}`,
      conflictAction: 'overwrite',
      saveAs: false,
    })
  } finally {
    // The download holds its own reference once started; give it a moment to begin.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** Opens a PDF in a new tab for review. The tab's URL lives as long as the panel. */
export async function previewPdf(file: GeneratedFile): Promise<void> {
  await chrome.tabs.create({ url: blobUrl(file), active: true })
}

/** Opens a saved file with the system's default app (Word for .docx). Needs a user gesture. */
export async function openSaved(downloadId: number): Promise<void> {
  await waitForComplete(downloadId)
  await chrome.downloads.open(downloadId)
}

function waitForComplete(downloadId: number, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener)
      reject(new Error('The file is still being saved. Try again in a moment.'))
    }, timeoutMs)

    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return
      if (delta.state.current === 'complete') finish()
      if (delta.state.current === 'interrupted') {
        clearTimeout(timer)
        chrome.downloads.onChanged.removeListener(listener)
        reject(new Error('Saving the file was interrupted.'))
      }
    }

    const finish = () => {
      clearTimeout(timer)
      chrome.downloads.onChanged.removeListener(listener)
      resolve()
    }

    chrome.downloads.onChanged.addListener(listener)
    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === 'complete') finish()
    })
  })
}
