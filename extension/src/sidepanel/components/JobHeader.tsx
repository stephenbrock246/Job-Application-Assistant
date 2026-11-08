/**
 * The job at the top of the Current Application card - editable, because pages do
 * not always say who is hiring (JobDiva, agency boards) and the company and
 * position name every saved file and folder.
 */

import { useEffect, useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { sendMessage } from '@/shared/utils/messaging'
import { hostnameOf } from '@/shared/utils/format'
import { Button, Icon, TextArea, TextInput } from './ui'

export function JobHeader() {
  const { session, perform, busy } = useAppState()
  const [editing, setEditing] = useState(false)
  const [company, setCompany] = useState('')
  const [position, setPosition] = useState('')

  const missingCompany = !session?.company.trim()

  // Per application (keyed on its id, not every update, so typing is not reset):
  // start from its names, and open straight into editing when the company is unknown.
  useEffect(() => {
    if (!session) return
    setCompany(session.company)
    setPosition(session.position)
    setEditing(!session.company.trim())
  }, [session?.id])

  if (!session) return null

  const save = () =>
    perform('job:edit', async () => {
      await sendMessage('session/updateJob', { sessionId: session.id, company, position })
      setEditing(false)
    })

  if (editing) {
    return (
      <div className="space-y-2 px-3 py-2.5">
        {missingCompany && (
          <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-amber-800">
            <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
            This page does not name the company. Enter it - it is used in the tailored resume, the cover
            letter and the saved file names.
          </p>
        )}
        <label className="block">
          <span className="label">Company</span>
          <TextInput
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder="e.g. Marathon TS"
            autoFocus={missingCompany}
          />
        </label>
        <label className="block">
          <span className="label">Position</span>
          <TextInput value={position} onChange={(event) => setPosition(event.target.value)} />
        </label>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!company.trim() || !position.trim()} loading={busy === 'job:edit'} onClick={() => void save()}>
            Save
          </Button>
          {!missingCompany && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCompany(session.company)
                setPosition(session.position)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight text-slate-900">
          {session.company || 'Unknown company'}
          {session.position ? ` — ${session.position}` : ''}
        </p>
        <p className="truncate text-2xs text-slate-400" title={session.jobUrl}>
          {hostnameOf(session.jobUrl)} &middot; row {session.sheetRow}
        </p>
      </div>
      <button
        onClick={() => setEditing(true)}
        className="shrink-0 text-2xs font-medium text-brand-600 hover:text-brand-700"
      >
        Edit
      </button>
    </div>
  )
}

/** Paste the real job description when the page extraction picked the wrong text. */
export function PasteDescription({ onDone }: { onDone: () => void }) {
  const { session, perform, busy } = useAppState()
  const [text, setText] = useState('')
  if (!session) return null

  return (
    <div className="space-y-1.5">
      <TextArea
        rows={6}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Copy the job description from the page and paste it here"
        className="text-[11px] leading-relaxed"
      />
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={text.trim().length < 200}
          loading={busy === 'job:description'}
          onClick={() =>
            void perform('job:description', async () => {
              await sendMessage('session/updateJob', { sessionId: session.id, description: text })
              onDone()
            })
          }
        >
          Use this description
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        {text.trim().length > 0 && text.trim().length < 200 && (
          <span className="text-2xs text-slate-400">Paste the full description</span>
        )}
      </div>
    </div>
  )
}
