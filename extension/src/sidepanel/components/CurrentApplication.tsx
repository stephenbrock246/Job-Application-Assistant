/**
 * The open application, as three steps:
 *
 *   1 Tailor   - CV (and cover letter) for this job
 *   2 Fill     - autofill the form; uploads and the cover letter go in automatically
 *   3 Submit   - the user submits on the site, then records Done or Skip
 */

import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useStorageSlot } from '../hooks/useStorageSlot'
import { AutofillSection } from './AutofillSection'
import { ResumeSection } from './ResumeSection'
import { AutopilotStatus } from './AutopilotStatus'
import { CoverLetterSection } from './CoverLetterSection'
import { DoneDialog } from './DoneDialog'
import { SkipDialog } from './SkipDialog'
import { profileSlot, readCanonicalValue } from '@/storage/applicant-profile'
import { AUTOFILL_SUMMARY_KEYS, CANONICAL_FIELD_BY_KEY } from '@/shared/constants/canonical-fields'
import { EMPTY_PROFILE } from '@/shared/constants/defaults'
import { Button, Card, Icon, cx } from './ui'
import { JobHeader, PasteDescription } from './JobHeader'
import { reportProblem } from '../lib/diagnostics'
import { useDialog } from './Modal'

export function CurrentApplication({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { session, busy, focusJobTab, refreshJobInfo, abandonSession } = useAppState()
  const [profile] = useStorageSlot(profileSlot, EMPTY_PROFILE)
  const [dialog, setDialog] = useState<'none' | 'done' | 'skip'>('none')
  const [pasting, setPasting] = useState(false)

  if (!session) return null

  const missing = AUTOFILL_SUMMARY_KEYS.filter((key) => !readCanonicalValue(profile, key)).map(
    (key) => CANONICAL_FIELD_BY_KEY.get(key)?.label ?? key,
  )
  const jobInfo = session.jobInfo
  const lowConfidence = Boolean(jobInfo && jobInfo.confidence < 0.7)

  return (
    <section>
      <Card className="divide-y divide-slate-100 overflow-hidden">
        <div className="flex items-start">
          <div className="min-w-0 flex-1">
            <JobHeader />
          </div>
          <button
            onClick={() => void focusJobTab()}
            title="Show the job tab"
            className="m-2 rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <Icon name="external" className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Job description: one line, details on demand. */}
        <div className="px-3 py-2">
          {pasting ? (
            <PasteDescription onDone={() => setPasting(false)} />
          ) : (
            <div className="flex items-center gap-2">
              <Icon
                name={jobInfo && !lowConfidence ? 'check' : 'alert'}
                className={cx('h-3.5 w-3.5 shrink-0', jobInfo && !lowConfidence ? 'text-emerald-500' : 'text-amber-500')}
              />
              <span className="min-w-0 flex-1 truncate text-xs text-slate-600">
                {!jobInfo
                  ? 'Job description not found yet'
                  : lowConfidence
                    ? 'Job description may be wrong - check or paste it'
                    : `Job description · ${jobInfo.description.length.toLocaleString()} chars`}
              </span>
              <LinkButton onClick={() => void refreshJobInfo()} busy={busy === 'extract'}>
                Re-scan
              </LinkButton>
              <LinkButton onClick={() => setPasting(true)}>Paste</LinkButton>
            </div>
          )}
          {jobInfo && !pasting && (
            <details className="mt-1">
              <summary className="cursor-pointer text-2xs text-slate-400 hover:text-slate-600">Preview</summary>
              <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-line text-2xs leading-relaxed text-slate-600">
                {jobInfo.description.slice(0, 3000)}
              </p>
            </details>
          )}
        </div>

        <Step number={1} title="Tailor CV and cover letter">
          <ResumeSection onOpenSettings={onOpenSettings} />
          <CoverLetterSection />
        </Step>

        <Step number={2} title="Fill the form">
          {missing.length > 0 && (
            <button
              onClick={() => onOpenSettings('profile')}
              className="mx-3 mt-2 flex w-[calc(100%-1.5rem)] items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-left text-2xs text-amber-800 hover:bg-amber-100"
              title={missing.join(', ')}
            >
              <Icon name="alert" className="h-3 w-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {missing.length} profile field{missing.length === 1 ? '' : 's'} empty: {missing.join(', ')}
              </span>
              <span className="shrink-0 font-medium">Edit</span>
            </button>
          )}
          <AutofillSection onOpenSettings={onOpenSettings} />
          <AutopilotStatus />
        </Step>

        <Step number={3} title="Submit on the site, then record it here">
          <div className="space-y-1.5 px-3 pb-2.5 pt-1">
            <div className="grid grid-cols-[1fr_2fr] gap-2">
              <Button variant="danger" size="sm" onClick={() => setDialog('skip')}>
                Skip
              </Button>
              <Button variant="success" size="sm" onClick={() => setDialog('done')}>
                <Icon name="check" className="h-3.5 w-3.5" />
                Done - applied
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <button
                onClick={() => void abandonSession()}
                className="text-2xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
              >
                Close without recording
              </button>
              <ReportProblemLink sessionId={session.id} />
            </div>
          </div>
        </Step>
      </Card>

      {dialog === 'done' && <DoneDialog onClose={() => setDialog('none')} />}
      {dialog === 'skip' && <SkipDialog onClose={() => setDialog('none')} />}
    </section>
  )
}

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 pt-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700 ring-1 ring-brand-200">
          {number}
        </span>
        <span className="text-xs font-semibold text-slate-800">{title}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * For mistakes the extension cannot see itself - a wrong value that looks filled,
 * a skipped question. Captures the job tab exactly as it is now.
 */
function ReportProblemLink({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [dialog, ask] = useDialog()

  const report = async () => {
    const answer = await ask({
      title: 'Report a problem',
      message: 'What went wrong on this page? The job tab is saved with a screenshot to the problem report (Settings > General).',
      input: { placeholder: 'Optional - e.g. "Salary was put in the phone field"' },
      confirmLabel: 'Save report',
    })
    if (typeof answer !== 'string') return
    const note = answer
    setState('saving')
    const id = await reportProblem({
      kind: 'user-report',
      message: note.trim() || 'Reported from the panel (no description).',
      origin: 'panel:report-button',
      manual: true,
      sessionId,
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    setState(id ? 'saved' : 'failed')
    setTimeout(() => setState('idle'), 4000)
  }

  return (
    <>
      {dialog}
      <button
        onClick={() => void report()}
        disabled={state === 'saving'}
        className="text-2xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-50"
        title="Save this page with a screenshot to the problem report (Settings > General)"
      >
        {state === 'saving' ? 'Saving...' : state === 'saved' ? 'Saved to problem report' : state === 'failed' ? 'Could not save' : 'Report a problem'}
      </button>
    </>
  )
}

function LinkButton({ onClick, busy, children }: { onClick: () => void; busy?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="shrink-0 text-2xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
    >
      {busy ? '...' : children}
    </button>
  )
}
