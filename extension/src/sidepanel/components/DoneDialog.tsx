import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { Modal } from './Modal'
import { sheetDate } from '@/shared/utils/format'
import { Button, Field, Icon, TextArea } from './ui'

/**
 * Done is the only path that writes "Applied". The confirmation wording is
 * deliberate: the extension cannot tell whether a submission succeeded, so the
 * user is asserting it, not confirming our guess.
 */
export function DoneDialog({ onClose }: { onClose: () => void }) {
  const { session, markDone, busy, sourceStatus, preferences } = useAppState()
  const [notes, setNotes] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  if (!session) return null

  // With a CSV the write lands in the working copy; the file itself changes on save.
  const isCsv = preferences.jobSourceId === 'csv'
  const willAutoSave = isCsv && preferences.autoSaveCsv && Boolean(sourceStatus?.canSaveInPlace)

  return (
    <Modal title="Mark as applied" onClose={onClose}>
      <div className="space-y-3">
        <div className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
          <p className="font-medium text-slate-800">
            {session.company}
            {session.position ? ` — ${session.position}` : ''}
          </p>
          <p className="mt-0.5 text-2xs text-slate-500">Row {session.sheetRow}</p>
        </div>

        <ul className="space-y-1 text-xs text-slate-600">
          <li className="flex justify-between gap-2">
            <span className="text-slate-400">Status</span>
            <span className="font-medium text-slate-800">Applied</span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-400">Applied Date</span>
            <span className="font-medium text-slate-800">{sheetDate()}</span>
          </li>
          <li className="flex justify-between gap-2">
            <span className="text-slate-400">Resume</span>
            <span className="truncate font-medium text-slate-800">
              {session.tailoredResume || '(none yet)'}
            </span>
          </li>
        </ul>

        <Field label="Notes (optional)">
          <TextArea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Anything worth remembering about this application"
          />
        </Field>

        <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
          />
          <span className="text-2xs leading-relaxed text-amber-800">
            I have confirmed on the site that this application was submitted successfully.
          </span>
        </label>

        {isCsv && !willAutoSave && (
          <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-slate-500">
            <Icon name="info" className="mt-px h-3 w-3 shrink-0" />
            This updates the working copy. Use <span className="font-medium">Save CSV</span> in Job
            source settings to write it back to your file.
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="success"
            size="sm"
            disabled={!confirmed}
            loading={busy === 'done'}
            onClick={() => {
              void markDone(notes.trim() || undefined).then(onClose)
            }}
          >
            Mark as applied
          </Button>
        </div>
      </div>
    </Modal>
  )
}
