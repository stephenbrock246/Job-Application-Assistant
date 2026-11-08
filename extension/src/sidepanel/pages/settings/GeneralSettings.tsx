import { useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { sessionsSlot } from '@/storage/sessions'
import { incidentsSlot } from '@/storage/diagnostics'
import { relativeTime } from '@/shared/utils/format'
import { sendMessage } from '@/shared/utils/messaging'
import { downloadProblemReport } from '../../lib/problem-report'
import { Button, Card, EmptyState, Toggle } from '../../components/ui'
import type { ApplicationSession } from '@/shared/types/application'
import type { IncidentSummary } from '@/shared/types/diagnostics'

export function GeneralSettings() {
  const { preferences, setPreference } = useAppState()
  const [sessions] = useStorageSlot(sessionsSlot, {} as Record<string, ApplicationSession>)
  const list = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <h2 className="mb-1 text-[13px] font-semibold text-slate-900">Behaviour</h2>
        <Toggle
          label="Open jobs in a new tab"
          hint="Keeps your current tab untouched."
          checked={preferences.openJobsInNewTab}
          onChange={(value) => void setPreference('openJobsInNewTab', value)}
        />
        <Toggle
          label='Set Status to "In Progress" when a job is opened'
          hint="Lets you resume later and keeps the sheet honest about what you started."
          checked={preferences.markInProgressOnOpen}
          onChange={(value) => void setPreference('markInProgressOnOpen', value)}
        />
        <Toggle
          label="Autofill each new application page"
          hint="When you move to a step not seen before, fill what your saved information covers. Existing values are never overwritten."
          checked={preferences.autofillOnNewPage}
          onChange={(value) => void setPreference('autofillOnNewPage', value)}
        />
        <Toggle
          label="Refresh the queue when the panel regains focus"
          checked={preferences.refreshOnFocus}
          onChange={(value) => void setPreference('refreshOnFocus', value)}
        />
        <Toggle
          label="Show completed jobs in the queue"
          hint="Off by default, so Applied and Failed rows stay out of the way."
          checked={preferences.showCompletedJobs}
          onChange={(value) => void setPreference('showCompletedJobs', value)}
        />
      </Card>

      <Card className="p-3">
        <h2 className="mb-2 text-[13px] font-semibold text-slate-900">Saved sessions</h2>
        {list.length === 0 ? (
          <EmptyState
            title="No sessions"
            description="Open a job to start an application session. Sessions survive a browser restart so you can pick up where you left off."
          />
        ) : (
          <ul className="space-y-1.5">
            {list.map((session) => (
              <li
                key={session.id}
                className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-slate-800">
                    {session.company || 'Unknown company'}
                  </p>
                  <p className="truncate text-2xs text-slate-500">
                    {session.status} &middot; row {session.sheetRow}
                    {session.steps?.length ? ` · step ${session.currentStep}` : ''} &middot;{' '}
                    {relativeTime(session.updatedAt)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ProblemReports />

      <Card className="p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Data</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Everything the extension knows is stored locally in this browser profile: your applicant
          details, saved answers, prompts, resume text, sessions and the imported job list. No
          passwords are stored, and AI access uses the browser session you are already signed into.
          Erasing this data also discards any unsaved changes to your CSV working copy.
        </p>
        <Button
          variant="danger"
          size="sm"
          className="mt-3"
          onClick={() => {
            if (confirm('Erase all locally stored JobApply Assistant data? This cannot be undone.')) {
              void chrome.storage.local.clear()
            }
          }}
        >
          Erase all local data
        </Button>
      </Card>
    </div>
  )
}

/** The black-box recorder: what went wrong, and a .zip to send to whoever fixes it. */
function ProblemReports() {
  const [incidents] = useStorageSlot(incidentsSlot, [] as IncidentSummary[])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const latest = [...incidents].sort((a, b) => b.lastAt - a.lastAt)

  const download = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const fileName = await downloadProblemReport()
      setStatus(`Saved to Downloads/JobApply/Problem reports/${fileName}`)
    } catch (error) {
      setStatus(`Could not create the report: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-3">
      <h2 className="text-[13px] font-semibold text-slate-900">Problem reports</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        {incidents.length === 0
          ? 'No problems recorded. When something goes wrong on a job page, it is saved here with a screenshot and a copy of the page.'
          : `${incidents.length} problem${incidents.length === 1 ? '' : 's'} recorded, latest ${relativeTime(latest[0]!.lastAt)}.`}
      </p>
      {latest.length > 0 && (
        <ul className="mt-2 space-y-1">
          {latest.slice(0, 5).map((incident) => (
            <li key={incident.id} className="truncate text-2xs text-slate-500" title={incident.message}>
              <span className="font-medium text-slate-700">{incident.company || 'No job'}</span> &middot;{' '}
              {incident.manual ? 'reported by you' : incident.kind}
              {incident.count > 1 ? ` ×${incident.count}` : ''} &middot; {incident.message}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" loading={busy} disabled={incidents.length === 0} onClick={() => void download()}>
          Download report
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={incidents.length === 0 || busy}
          onClick={() => {
            if (confirm('Delete all recorded problems and the step log?')) {
              void sendMessage('diag/clear').then(() => setStatus(null))
            }
          }}
        >
          Clear
        </Button>
      </div>
      {status && <p className="mt-2 break-all text-2xs text-slate-500">{status}</p>}
      <p className="mt-2 text-2xs leading-relaxed text-slate-400">
        The report includes screenshots of job pages and what was typed into them (your contact details and answers).
        Share it only with the person fixing the extension.
      </p>
    </Card>
  )
}
