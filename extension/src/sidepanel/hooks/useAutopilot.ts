/**
 * Autopilot: puts the approved files and text into the form, once per page.
 *
 *   resume upload field + approved CV            -> attach it
 *   cover letter upload field + approved letter  -> attach it
 *   cover letter text box + approved letter      -> paste its text
 *
 * Nothing is generated here: tailoring starts only when the user presses Tailor.
 * Each upload/paste is recorded on the session, so a failure is reported once and
 * never retried in a loop. It never submits and never presses Done.
 */

import { useEffect, useRef, useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useStorageSlot } from './useStorageSlot'
import { masterResumeSlot } from '@/storage/settings'
import { runSlot } from '@/storage/run'
import { useRunnerActive } from '../lib/runner'
import type { RunState } from '@/shared/types/run'
import { MessageError, sendMessage } from '@/shared/utils/messaging'
import { reportProblem } from '../lib/diagnostics'
import {
  attachToField,
  emptyUploadFields,
  isCoverLetterUpload,
  isResumeUpload,
  letterFileFor,
  resumeFileFor,
} from '../lib/writing-actions'
import type { ApplicationField, ApplicationSession, AutopilotState } from '@/shared/types/application'
import type { MasterResumeMeta, Preferences } from '@/shared/types/settings'

type Action = () => Promise<void>

export function useAutopilot(): void {
  const { session, preferences } = useAppState()
  const [master] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)
  const [run] = useStorageSlot(runSlot, { mode: 'idle', status: '', items: {} } as RunState)
  const runsHere = useRunnerActive()
  const busy = useRef(false)
  const [tick, setTick] = useState(0)

  // The job autopilot is working on in another window is its to fill: two panels
  // uploading into the same field at once would attach the file twice.
  const runOwns =
    !runsHere && run.mode === 'running' && Boolean(session) && Boolean(run.currentKey) && run.items[run.currentKey!]?.sessionId === session?.id

  useEffect(() => {
    if (!session || busy.current || runOwns) return
    busy.current = true
    void runAutopilotStep(session, master, preferences)
      .catch(() => 'idle' as const)
      .then((outcome) => {
        busy.current = false
        // Re-evaluate: another field may be waiting.
        if (outcome === 'ran') setTick((value) => value + 1)
      })
  }, [session, master, preferences, tick, runOwns])
}

/** Sessions with an upload or paste in progress, whoever started it (this hook or the unattended run). */
const working = new Set<string>()

/**
 * Does the next upload/paste for this application, if one is due.
 *   ran:  did one (call again - another may be waiting)
 *   busy: one is already in progress for this application
 *   idle: nothing to do
 */
export async function runAutopilotStep(
  session: ApplicationSession,
  master: MasterResumeMeta | null,
  prefs: Preferences,
): Promise<'ran' | 'busy' | 'idle'> {
  if (working.has(session.id)) return 'busy'
  const action = nextAction(session, master, prefs)
  if (!action) return 'idle'
  working.add(session.id)
  try {
    await action()
    return 'ran'
  } finally {
    working.delete(session.id)
  }
}

// ---------------------------------------------------------------------------

function nextAction(session: ApplicationSession, master: MasterResumeMeta | null, prefs: Preferences): Action | null {
  const report = session.lastReport
  if (!prefs.autoAttachFiles || !report) return null
  const ap = session.autopilot ?? {}
  const done = (key: string) => Boolean(ap.attached?.[key])

  // Cover letter text box.
  const letter = session.coverLetter
  if (letter?.approved && letter.text.trim()) {
    const box = [...report.ask, ...report.skipped]
      .map((plan) => plan.field)
      .find((field) => !field.value && field.canonicalField === 'coverLetter' && (field.type === 'textarea' || field.type === 'text'))
    const key = box ? `text:${box.id}@${report.url}` : ''
    if (box && !done(key)) return () => pasteLetter(session, box, key)
  }

  // Upload fields.
  for (const field of emptyUploadFields(session)) {
    const key = `${field.id}@${report.url}`
    if (done(key)) continue
    if (isResumeUpload(field.label) && session.resume?.approved) {
      return () => attach(session, field, key, () => resumeFileFor(session, master, field.accept))
    }
    if (isCoverLetterUpload(field.label) && letter?.approved) {
      return () => attach(session, field, key, () => letterFileFor(session))
    }
  }
  return null
}

async function attach(
  session: ApplicationSession,
  field: ApplicationField,
  key: string,
  build: () => Promise<{ fileName: string; bytes: Uint8Array; mime: string }>,
): Promise<void> {
  let fileName = ''
  let ok = false
  let note: string | undefined
  // A request the worker failed is recorded there; a refused upload or a file that could not be built is not.
  let recordedByWorker = false
  try {
    const file = await build()
    fileName = file.fileName
    const result = await attachToField(session.id, field.id, file)
    ok = result.attached
    note = result.error
  } catch (error) {
    note = message(error)
    recordedByWorker = error instanceof MessageError
  }
  await record(session, key, { fileName, ok, at: Date.now(), ...(note ? { note } : {}) })
  if (!ok && !recordedByWorker) {
    void reportProblem({
      kind: 'upload-failed',
      message: `Could not upload ${fileName || 'the file'} to "${field.label}": ${note ?? 'the page did not accept it'}`,
      origin: 'autopilot',
      sessionId: session.id,
      data: { field: { label: field.label, accept: field.accept }, fileName },
    })
  }
}

/** Pastes the cover letter text into the form's cover letter box. */
async function pasteLetter(session: ApplicationSession, field: ApplicationField, key: string): Promise<void> {
  let ok = false
  let note: string | undefined
  try {
    await sendMessage('page/answerField', {
      sessionId: session.id,
      fieldId: field.id,
      value: session.coverLetter!.text,
      saveAsDefault: false,
      label: field.label,
      canonicalField: 'coverLetter',
    })
    ok = true
  } catch (error) {
    note = message(error)
  }
  await record(session, key, { fileName: 'the cover letter text', ok, at: Date.now(), ...(note ? { note } : {}) })
}

type Attached = NonNullable<AutopilotState['attached']>[string]

function record(session: ApplicationSession, key: string, entry: Attached): Promise<void> {
  const autopilot: AutopilotState = {
    ...(session.autopilot ?? {}),
    attached: { ...(session.autopilot?.attached ?? {}), [key]: entry },
  }
  return sendMessage('session/updateWriting', { sessionId: session.id, patch: { autopilot } }).then(() => undefined)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
