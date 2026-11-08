import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { Modal } from './Modal'
import { SKIP_REASONS, type SkipReason } from '@/shared/types/job'
import { Button, Field, Select, TextArea } from './ui'

/** Spec section 24 - Failed/Skip, always a deliberate user choice. */
export function SkipDialog({ onClose }: { onClose: () => void }) {
  const { session, markFailed, busy } = useAppState()
  const [reason, setReason] = useState<SkipReason>(SKIP_REASONS[0])
  const [notes, setNotes] = useState('')

  if (!session) return null

  return (
    <Modal title="Skip this job" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-slate-600">
          This sets Status to <span className="font-medium text-slate-800">Failed</span> and writes
          the reason into the Other column, so the job leaves your ready queue.
        </p>

        <Field label="Reason">
          <Select value={reason} onChange={(event) => setReason(event.target.value as SkipReason)}>
            {SKIP_REASONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Details (optional)">
          <TextArea
            rows={2}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="e.g. requires fluent German"
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy === 'failed'}
            onClick={() => {
              void markFailed(reason, notes.trim() || undefined).then(onClose)
            }}
          >
            Mark as failed
          </Button>
        </div>
      </div>
    </Modal>
  )
}
