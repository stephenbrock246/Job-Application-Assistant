/**
 * Reading and writing the user's CSV file from the side panel.
 *
 * Three layers, best first, because the File System Access API is not guaranteed
 * to be available in every Chrome build or extension context:
 *
 *   1. A stored file handle  -> "Save" overwrites the original file, no dialog.
 *   2. showSaveFilePicker    -> the user chooses where, and we keep the handle.
 *   3. chrome.downloads      -> a normal download to the Downloads folder.
 *
 * Every step degrades rather than failing, and the caller is told which one ran so
 * the UI can be honest about what just happened.
 */

import {
  clearHandle,
  getStoredHandle,
  requestWritePermission,
  storeHandle,
  supportsFileSystemAccess,
} from './file-handles'

export interface PickedCsv {
  fileName: string
  text: string
  /** True when we kept a handle capable of saving in place later. */
  hasFileHandle: boolean
}

export type SaveMethod = 'in-place' | 'save-as' | 'download'

export interface SaveResult {
  method: SaveMethod
  fileName: string
  hasFileHandle: boolean
}

/** Opens the CSV, keeping a writable handle when the browser allows it. */
export async function pickCsvFile(): Promise<PickedCsv | null> {
  if (supportsFileSystemAccess()) {
    try {
      const picker = (window as unknown as {
        showOpenFilePicker: (options: unknown) => Promise<FileSystemFileHandle[]>
      }).showOpenFilePicker

      const [handle] = await picker({
        multiple: false,
        types: [
          {
            description: 'CSV files',
            accept: { 'text/csv': ['.csv'], 'text/plain': ['.csv', '.tsv', '.txt'] },
          },
        ],
      })
      if (!handle) return null

      const file = await handle.getFile()
      const text = await file.text()

      // Ask for write access now, while we still have the user's gesture.
      const writable = await requestWritePermission(handle)
      if (writable) await storeHandle(handle)
      else await clearHandle()

      return { fileName: file.name, text, hasFileHandle: writable }
    } catch (error) {
      // An abort is the user closing the dialog, not a failure worth reporting.
      if (isAbort(error)) return null
      // Anything else: fall through to the input-element path.
    }
  }

  return pickViaInput()
}

/** Fallback picker that works anywhere a DOM does. */
function pickViaInput(): Promise<PickedCsv | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.tsv,text/csv,text/plain'
    input.style.display = 'none'

    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) {
        resolve(null)
        return
      }
      void file.text().then((text) => resolve({ fileName: file.name, text, hasFileHandle: false }))
    })

    // A cancelled dialog fires no event in some builds; the panel simply stays put.
    document.body.appendChild(input)
    input.click()
  })
}

/** Writes the CSV text back out, preferring in-place overwrite. */
export async function saveCsvFile(fileName: string, text: string): Promise<SaveResult> {
  const stored = await getStoredHandle()

  if (stored) {
    const granted =
      stored.permission === 'granted' || (await requestWritePermission(stored.handle))
    if (granted) {
      try {
        await writeToHandle(stored.handle, text)
        return { method: 'in-place', fileName: stored.handle.name || fileName, hasFileHandle: true }
      } catch {
        // The file may have been moved or deleted; drop the stale handle.
        await clearHandle()
      }
    }
  }

  if (supportsFileSystemAccess()) {
    try {
      const picker = (window as unknown as {
        showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>
      }).showSaveFilePicker

      const handle = await picker({
        suggestedName: fileName,
        types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
      })

      await writeToHandle(handle, text)
      await storeHandle(handle)
      return { method: 'save-as', fileName: handle.name || fileName, hasFileHandle: true }
    } catch (error) {
      if (isAbort(error)) throw error
      // Fall through to a plain download.
    }
  }

  await downloadCsv(fileName, text)
  return { method: 'download', fileName, hasFileHandle: false }
}

async function writeToHandle(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable()
  try {
    await writable.write(text)
  } finally {
    await writable.close()
  }
}

async function downloadCsv(fileName: string, text: string): Promise<void> {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    await chrome.downloads.download({ url, filename: fileName, saveAs: true })
  } finally {
    // The download reads the blob asynchronously, so give it a moment before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export async function forgetCsvHandle(): Promise<void> {
  await clearHandle()
}
