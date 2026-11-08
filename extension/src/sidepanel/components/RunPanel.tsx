/**
 * The unattended run, as seen on the second monitor: what it is doing now, the
 * applications waiting for approval, and the ones that need the user.
 */

import { useEffect, useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useStorageSlot } from '../hooks/useStorageSlot'
import { runSlot } from '@/storage/run'
import { sendMessage } from '@/shared/utils/messaging'
import { continueJob, runSetup, runSetupProblems, startRunner, stopRunner, useRunnerActive, type RunSetup } from '../lib/runner'
import { Badge, Button, Card, Icon, Spinner } from './ui'
import { useDialog } from './Modal'
import type { RunItem, RunState } from '@/shared/types/run'

type Ask = ReturnType<typeof useDialog>[1]

/** A heartbeat older than this means the panel running it was closed. */
const STALE_MS = 60_000

export function RunPanel() {
  const { perform, busy, preferences } = useAppState()
  const [run] = useStorageSlot(runSlot, { mode: 'idle', status: '', items: {} } as RunState)
  const activeHere = useRunnerActive()
  const now = useNow(15_000)

  const items = Object.values(run.items).sort((a, b) => b.at - a.at)
  const byState = (...states: RunItem['state'][]) => items.filter((item) => states.includes(item.state))
  const ready = byState('ready', 'submitting')
  const help = byState('needs-help', 'check')
  const submitted = byState('submitted')
  const skipped = byState('skipped')
  const working = byState('working')

  const stale = run.mode === 'running' && !activeHere && now - (run.heartbeatAt ?? 0) > STALE_MS
  const elsewhere = run.mode === 'running' && !activeHere && !stale
  const [setupState, setSetupState] = useState<RunSetup | null>(null)
  // Re-read when settings change (a key saved, a resume uploaded) or the panel comes back from Settings.
  useEffect(() => {
    void runSetup(preferences).then(setSetupState)
  }, [preferences, now])
  const setup = setupState ? runSetupProblems(preferences, setupState) : []

  const start = () => perform('run:start', startRunner)
  const stop = () => perform('run:stop', stopRunner)
  const review = (item: RunItem) =>
    perform(`run:review:${item.key}`, async () => {
      await sendMessage('run/review', { key: item.key })
    })
  const submit = (item: RunItem) =>
    perform(`run:submit:${item.key}`, async () => {
      await sendMessage('run/approve', { key: item.key })
    })
  const [dialog, ask] = useDialog()

  return (
    <Card className="overflow-hidden">
      {dialog}
      <div className="flex items-center justify-between px-3 pt-2.5">
        <div className="flex items-center gap-2">
          <Icon name="sparkle" className="h-3.5 w-3.5 text-brand-600" />
          <span className="text-[13px] font-semibold text-slate-900">Autopilot</span>
          {activeHere && <Badge tone="blue">Running</Badge>}
          {elsewhere && <Badge tone="blue">Running in another window</Badge>}
          {stale && <Badge tone="amber">Interrupted</Badge>}
        </div>
        {activeHere ? (
          <Button size="sm" variant="secondary" loading={busy === 'run:stop'} onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          !elsewhere && (
            <Button size="sm" disabled={!setupState || setup.length > 0} loading={busy === 'run:start'} onClick={() => void start()}>
              {stale ? 'Resume' : 'Start'}
            </Button>
          )
        )}
      </div>

      <div className="space-y-2 px-3 pb-3 pt-1.5">
        {activeHere ? (
          <div className="flex items-start gap-2 rounded-lg bg-brand-50/70 px-2.5 py-2">
            <Spinner className="mt-0.5 h-3 w-3 shrink-0 text-brand-700" />
            <p className="min-w-0 flex-1 text-2xs leading-relaxed text-brand-800">{run.status || 'Working...'}</p>
          </div>
        ) : stale ? (
          <p className="text-2xs leading-relaxed text-amber-800">
            The run stopped because this panel was closed. Press Resume to carry on - keep the panel open while it runs.
          </p>
        ) : (
          <div className="text-2xs leading-relaxed text-slate-500">
            {run.status && run.mode === 'idle' && <p className="text-slate-600">{run.status}</p>}
            <details>
              <summary className="cursor-pointer select-none hover:text-slate-700">
                Applies to your Ready jobs one by one - you approve every submit.
              </summary>
              <p className="mt-1">
                For each job it tailors the CV and cover letter, opens the form and fills it, then waits for your
                approval before submitting. The next job starts only after that. Keep this window open (not
                minimised) while it runs.
              </p>
            </details>
          </div>
        )}

        {!activeHere && setup.map((problem) => (
          <p key={problem} className="flex items-start gap-1.5 text-2xs text-amber-800">
            <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
            {problem}
          </p>
        ))}

        {(ready.length > 0 || help.length > 0 || submitted.length > 0 || working.length > 0) && (
          <div className="grid grid-cols-3 gap-1.5 text-center">
            <Count label="Ready" value={ready.length} tone="text-emerald-700" />
            <Count label="Need you" value={help.length} tone="text-amber-700" />
            <Count label="Submitted" value={submitted.length} tone="text-slate-700" />
          </div>
        )}

        {ready.length > 0 && (
          <Group title="Ready for your approval">
            {ready.map((item) => (
              <Row key={item.key} item={item}>
                {item.state === 'submitting' ? (
                  <span className="flex items-center gap-1 text-2xs text-slate-500">
                    <Spinner className="h-3 w-3" /> Submitting
                  </span>
                ) : (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => void review(item)}>
                      Review
                    </Button>
                    <SkipButton item={item} ask={ask} />
                    <Button
                      size="sm"
                      variant="success"
                      loading={busy === `run:submit:${item.key}`}
                      onClick={async () => {
                        const yes = await ask({
                          title: 'Submit this application?',
                          message: `${item.company || 'This job'}${item.position ? ` - ${item.position}` : ''}. The form is submitted on the site exactly as it is filled now.`,
                          confirmLabel: 'Submit',
                          tone: 'success',
                        })
                        if (yes) void submit(item)
                      }}
                    >
                      Submit
                    </Button>
                  </>
                )}
              </Row>
            ))}
          </Group>
        )}

        {help.length > 0 && (
          <Group title="Needs your help">
            {help.map((item) => (
              <Row key={item.key} item={item}>
                <Button size="sm" variant="ghost" onClick={() => void review(item)}>
                  Open
                </Button>
                {item.state === 'needs-help' && item.sessionId && !item.retry && !elsewhere && (
                  <Button size="sm" variant="secondary" onClick={() => void perform(`run:continue:${item.key}`, () => continueJob(item))} title="Fixed it? Let autopilot finish this one.">
                    Continue
                  </Button>
                )}
                <SkipButton item={item} ask={ask} />
              </Row>
            ))}
          </Group>
        )}

        {submitted.length + skipped.length > 0 && (
          <details>
            <summary className="cursor-pointer text-2xs text-slate-400 hover:text-slate-600">
              {submitted.length} submitted{skipped.length ? ` · ${skipped.length} skipped` : ''}
            </summary>
            <ul className="mt-1 space-y-0.5">
              {[...submitted, ...skipped].map((item) => (
                <li key={item.key} className="flex items-center gap-1.5 truncate text-2xs text-slate-500" title={item.reason}>
                  <Icon name={item.state === 'submitted' ? 'check' : 'alert'} className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {item.company} {item.position ? `· ${item.position}` : ''} {item.state === 'skipped' ? '· skipped' : ''}
                  </span>
                </li>
              ))}
            </ul>
            {(submitted.length > 0 || skipped.length > 0) && (
              <button
                onClick={() => void Promise.all([...submitted, ...skipped].map((item) => sendMessage('run/dismiss', { key: item.key })))}
                className="mt-1 text-2xs text-slate-400 hover:text-slate-600"
              >
                Clear this list
              </button>
            )}
          </details>
        )}
      </div>
    </Card>
  )
}

/**
 * Moves on without this job: it is marked skipped for this run (so it is not
 * picked again; its tab stays open), and the run starts the next one. On a
 * "check" item - submitted, confirmation not seen - it just clears it.
 */
function SkipButton({ item, ask }: { item: RunItem; ask: Ask }) {
  const label = item.state === 'check' ? 'Done' : 'Skip'
  return (
    <button
      onClick={async () => {
        if (item.state === 'check') {
          void sendMessage('run/dismiss', { key: item.key })
          return
        }
        const yes = await ask({
          title: 'Skip this job?',
          message: `${item.company || 'This job'} is left as it is (its tab stays open) and autopilot goes on to the next job.`,
          confirmLabel: 'Skip',
          tone: 'danger',
        })
        if (yes) {
          const { retry: _retry, problems: _problems, ...rest } = item
          void sendMessage('run/item', { ...rest, state: 'skipped', reason: 'Skipped by you.' })
        }
      }}
      title={item.state === 'check' ? 'Remove from this list' : 'Go on to the next job without this one'}
      className="rounded px-1.5 py-1 text-2xs text-slate-400 hover:bg-slate-100 hover:text-slate-600"
    >
      {label}
    </button>
  )
}

function Count({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg bg-slate-50 py-1.5">
      <p className={`text-sm font-semibold ${tone}`}>{value}</p>
      <p className="text-2xs text-slate-500">{label}</p>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{children}</ul>
    </div>
  )
}

function Row({ item, children }: { item: RunItem; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-slate-800">
          {item.company || 'Unknown company'}
          {item.position ? <span className="font-normal text-slate-500"> · {item.position}</span> : null}
        </p>
        {item.reason && (
          <p className="line-clamp-2 text-2xs leading-snug text-slate-500" title={item.problems?.join('\n') ?? item.reason}>
            {item.reason}
            {item.problems && item.problems.length > 1 ? ` (+${item.problems.length - 1} more)` : ''}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </li>
  )
}

/** The current time, refreshed every `ms` - for "has the run gone quiet?". */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}
