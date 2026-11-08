import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { STATUS_LABELS } from '@/shared/constants/sheet'
import { hostnameOf, initialsOf } from '@/shared/utils/format'
import { Badge, Button, EmptyState, SectionTitle, cx } from './ui'
import type { SheetJob } from '@/shared/types/job'

const COLLAPSED_COUNT = 5

export function JobQueue({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { sourceStatus, visibleJobs, queue, preferences, setPreference } = useAppState()
  const [expanded, setExpanded] = useState(false)

  if (!sourceStatus?.connected) {
    const isCsv = preferences.jobSourceId === 'csv'
    return (
      <section>
        <SectionTitle>Job Queue</SectionTitle>
        <EmptyState
          title={isCsv ? 'Import your job list' : 'Connect a Google Sheet'}
          description={
            isCsv
              ? 'Pick the .csv holding your jobs. It needs a Job Link and a Status column; everything else is optional. Nothing leaves this browser.'
              : 'Sign in and choose the spreadsheet that holds your job list.'
          }
          action={
            <Button onClick={() => onOpenSettings('source')}>
              {isCsv ? 'Import CSV' : 'Open source settings'}
            </Button>
          }
        />
      </section>
    )
  }

  const jobs = expanded ? visibleJobs : visibleJobs.slice(0, COLLAPSED_COUNT)
  const hiddenCount = (queue?.jobs.length ?? 0) - visibleJobs.length

  return (
    <section>
      <SectionTitle
        action={
          visibleJobs.length > COLLAPSED_COUNT ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-2xs font-medium text-brand-600 hover:text-brand-700"
            >
              {expanded ? 'Show less' : `Show all (${visibleJobs.length})`}
            </button>
          ) : null
        }
      >
        Job Queue{visibleJobs.length ? ` (${visibleJobs.length})` : ''}
      </SectionTitle>

      {visibleJobs.length === 0 ? (
        <EmptyState
          title={hiddenCount > 0 ? 'Nothing left to apply to' : 'No jobs found'}
          description={
            hiddenCount > 0
              ? `${hiddenCount} completed row${hiddenCount === 1 ? '' : 's'} are hidden. Add new rows to your job list, or show completed jobs.`
              : 'No rows have a blank or in-progress Status. Check that the right header row was detected in settings.'
          }
          action={
            hiddenCount > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void setPreference('showCompletedJobs', true)}
              >
                Show completed
              </Button>
            ) : null
          }
        />
      ) : (
        <ul className="card divide-y divide-slate-100 overflow-hidden">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </ul>
      )}

      {preferences.showCompletedJobs && (
        <button
          onClick={() => void setPreference('showCompletedJobs', false)}
          className="mt-2 text-2xs text-slate-400 hover:text-slate-600"
        >
          Hide completed jobs
        </button>
      )}
    </section>
  )
}

function JobRow({ job }: { job: SheetJob }) {
  const { openJob, busy, session } = useAppState()
  const isCurrent = session?.sheetRow === job.rowNumber
  const actionable = job.status === 'READY' || job.status === 'IN_PROGRESS'

  return (
    <li
      className={cx(
        'flex items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-slate-50',
        isCurrent && 'bg-brand-50/60 hover:bg-brand-50/60',
      )}
    >
      <span
        className={cx(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold',
          isCurrent ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600',
        )}
      >
        {initialsOf(job.company || job.position)}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold leading-tight text-slate-900">
          <span className="truncate">{job.company || 'Unknown company'}</span>
          {job.status !== 'READY' && (
            <Badge tone={job.status === 'APPLIED' ? 'green' : job.status === 'FAILED' ? 'red' : 'amber'}>
              {STATUS_LABELS[job.status]}
            </Badge>
          )}
        </p>
        <p className="truncate text-xs leading-snug text-slate-600" title={job.position}>
          {job.position || 'Untitled role'}
        </p>
        <p className="truncate text-2xs text-slate-400">{hostnameOf(job.jobLink) || `Row ${job.rowNumber}`}</p>
      </div>

      <Button
        size="sm"
        variant={isCurrent || !actionable ? 'secondary' : 'primary'}
        onClick={() => void openJob(job.id)}
        loading={busy === 'open' && isCurrent}
        disabled={!job.jobLink}
        title={job.jobLink || 'This row has no Job Link'}
      >
        {isCurrent ? 'Show' : job.status === 'IN_PROGRESS' ? 'Resume' : 'Open'}
      </Button>
    </li>
  )
}
