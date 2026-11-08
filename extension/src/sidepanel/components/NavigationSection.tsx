/**
 * Multi-page progress and the Next control (spec sections 17 and 18).
 *
 * The button asks the background to finish the page, click Next, and verify that
 * the page actually changed. The result shown underneath is what was observed,
 * never what was hoped for.
 */

import { useAppState } from '../state/AppStateContext'
import { relativeTime } from '@/shared/utils/format'
import { Button, Icon, cx } from './ui'
import type { NavigationOutcome, NavigationResult } from '@/shared/types/application'

const TONE: Record<NavigationOutcome, 'green' | 'amber' | 'red' | 'neutral'> = {
  ADVANCED: 'green',
  RETURNED: 'amber',
  BLOCKED: 'amber',
  VALIDATION_FAILED: 'red',
  NO_CHANGE: 'amber',
  NO_CONTROL: 'neutral',
  SUBMIT_REFUSED: 'neutral',
  CANCELLED: 'neutral',
}

const TONE_CLASSES = {
  green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  red: 'border-red-200 bg-red-50 text-red-700',
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
}

export function NavigationSection() {
  const { session, busy, nextPage, cancelNext } = useAppState()
  if (!session) return null

  const report = session.lastReport
  const steps = session.steps ?? []
  const nav = session.lastNavigation
  const onForm = steps.length > 0
  const nextKind = report?.nextButtonKind ?? null

  // Nothing to show until a form has been seen: the Autofill hint above already says what to do.
  if (!onForm && !session.confirmationDetected && !nav) return null

  return (
    <div className="space-y-2">
      {onForm && (
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-slate-800">Pages</span>
          <span className="text-2xs text-slate-400">
            Step {session.currentStep}
            {session.totalStepsSeen > 1 ? ` of ${session.totalStepsSeen} seen` : ''}
          </span>
        </div>
      )}

      {onForm ? (
        <ol className="flex flex-wrap items-center gap-1">
          {steps.map((step) => {
            const current = step.step === session.currentStep
            const complete = step.totalFields > 0 && step.completedFields >= step.totalFields
            return (
              <li
                key={step.step}
                title={`${step.page.heading || `Step ${step.step}`} - ${step.completedFields}/${step.totalFields} fields`}
                className={cx(
                  'flex h-5 min-w-[20px] items-center justify-center rounded-full border px-1.5 text-2xs font-semibold',
                  current
                    ? 'border-brand-500 bg-brand-500 text-white'
                    : complete
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                      : 'border-slate-300 bg-white text-slate-500',
                )}
              >
                {step.step}
              </li>
            )
          })}
        </ol>
      ) : null}

      {session.confirmationDetected && (
        <div className="flex items-start gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2">
          <Icon name="check" className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <p className="text-2xs leading-relaxed text-emerald-800">
            This page reads like a submission confirmation. If your application went through,
            press <span className="font-semibold">Done</span> below to record it.
          </p>
        </div>
      )}

      {!onForm ? null : nextKind === 'submit' ? (
        <div className="flex items-start gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
          <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
          <p className="text-2xs leading-relaxed text-slate-600">
            Final step. Review the application, then press &ldquo;{report?.nextButtonLabel}&rdquo; on
            the page yourself. The extension never submits for you.
          </p>
        </div>
      ) : (
        <Button
          size="sm"
          className="w-full"
          onClick={() => void nextPage()}
          loading={busy === 'next'}
          onCancel={() => void cancelNext()}
          disabled={Boolean(busy) && busy !== 'next'}
          title="Fill what can be filled, click Next on the page, and check that it moved"
        >
          {nextKind === 'next' && report?.nextButtonLabel
            ? `${report.nextButtonLabel} →`
            : 'Next page →'}
        </Button>
      )}

      {nav && <NavigationOutcomeCard nav={nav} />}
    </div>
  )
}

function NavigationOutcomeCard({ nav }: { nav: NavigationResult }) {
  const { highlightField, nextPage, busy } = useAppState()
  const tone = TONE[nav.outcome]

  return (
    <div className={cx('space-y-1.5 rounded-lg border px-2.5 py-2', TONE_CLASSES[tone])}>
      <div className="flex items-start gap-1.5">
        <Icon
          name={
            nav.outcome === 'ADVANCED'
              ? 'check'
              : nav.outcome === 'NO_CONTROL' || nav.outcome === 'SUBMIT_REFUSED' || nav.outcome === 'CANCELLED'
                ? 'info'
                : 'alert'
          }
          className="mt-px h-3.5 w-3.5 shrink-0"
        />
        <p className="flex-1 text-2xs leading-relaxed">{nav.message}</p>
        <span className="shrink-0 text-2xs opacity-60">{relativeTime(nav.at)}</span>
      </div>

      {nav.autoCorrected ? (
        <p className="text-2xs opacity-80">
          Automatically filled {nav.autoCorrected} more field{nav.autoCorrected === 1 ? '' : 's'} and
          retried once.
        </p>
      ) : null}

      {nav.blockingFields && nav.blockingFields.length > 0 && (
        <>
          <ul className="space-y-0.5">
            {nav.blockingFields.slice(0, 8).map((field) => (
              <li key={field.id}>
                <button
                  onClick={() => void highlightField(field.id)}
                  className="flex w-full items-center gap-1 text-left text-2xs underline-offset-2 hover:underline"
                  title="Show me this field on the page"
                >
                  <Icon name="external" className="h-3 w-3 shrink-0" />
                  <span className="truncate">{field.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => void nextPage(true)}
            disabled={busy === 'next'}
            className="text-2xs font-medium underline underline-offset-2 disabled:opacity-50"
          >
            Continue anyway
          </button>
        </>
      )}

      {nav.outcome === 'VALIDATION_FAILED' && nav.errors.length > 0 && (
        <ul className="space-y-0.5">
          {nav.errors.slice(0, 6).map((error, index) => (
            <li key={`${error.fieldId ?? 'page'}-${index}`} className="flex items-start gap-1 text-2xs">
              {error.fieldId ? (
                <button
                  onClick={() => void highlightField(error.fieldId!)}
                  className="text-left underline-offset-2 hover:underline"
                >
                  {error.message}
                </button>
              ) : (
                <span>{error.message}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
