/**
 * The autofill half of the Current Application card: scan results, what was
 * filled, what needs the user, and what was deliberately left alone.
 */

import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { MissingInfoCard } from './MissingInfoCard'
import { NavigationSection } from './NavigationSection'
import { FieldChecklist } from './FieldChecklist'
import { QuestionsBatch } from './QuestionsBatch'
import { hostnameOf, relativeTime } from '@/shared/utils/format'
import { sendMessage } from '@/shared/utils/messaging'
import { Badge, Button, Icon, cx } from './ui'
import type { AutofillReport } from '@/shared/types/application'

export function AutofillSection({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { session, busy, scanPage, autofillPage, perform } = useAppState()
  const report = session?.lastReport
  const [showSkipped, setShowSkipped] = useState(false)

  if (!session) return null

  // Optional fields the extension could not fill but the user can: no saved value,
  // unrecognised, unsure, a written answer, or an upload. Filled fields and
  // legal/demographic questions stay in the plain "skipped" list.
  const answerable = new Set(['NO_VALUE', 'UNMAPPED', 'LOW_CONFIDENCE', 'AI_REQUIRED', 'FILE_UPLOAD'])
  const optionalOpen = (report?.skipped ?? []).filter(
    (plan) =>
      answerable.has(plan.reasonCode ?? '') &&
      plan.field.category !== 'USER_CONFIRMATION_REQUIRED' &&
      !plan.field.value,
  )
  const settled = (report?.skipped ?? []).filter((plan) => !optionalOpen.includes(plan))

  return (
    <div className="space-y-2.5 px-3 py-2.5">
      <div className="grid grid-cols-[2fr_1fr] gap-2">
        <Button onClick={() => void autofillPage()} loading={busy === 'autofill'}>
          <Icon name="sparkle" className="h-3.5 w-3.5" />
          Autofill form
        </Button>
        <Button variant="secondary" onClick={() => void scanPage()} loading={busy === 'scan'}>
          <Icon name="refresh" className="h-3 w-3" />
          Scan
        </Button>
      </div>

      {report ? (
        <ReportSummary report={report} />
      ) : (
        <p className="text-2xs text-slate-400">Open the application form in the job tab, then press Autofill form.</p>
      )}

      {report?.embeddedForms?.map((url) => (
        <div key={url} className="space-y-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
          <p className="text-2xs leading-relaxed text-amber-800">
            The application form on this page is embedded from{' '}
            <span className="font-medium">{hostnameOf(url)}</span>. Browsers keep other sites' frames
            separate, so its fields cannot be read from here.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void perform('embedded', () =>
                sendMessage('page/openEmbedded', { sessionId: session.id, url }).then(() => undefined),
              )
            }
          >
            <Icon name="external" className="h-3 w-3" />
            Open the form directly
          </Button>
        </div>
      ))}

      <QuestionsBatch onOpenSettings={onOpenSettings} />

      {report?.fields && <FieldChecklist fields={report.fields} />}

      {report && report.ask.length > 0 && (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700">
            <Icon name="alert" className="h-3.5 w-3.5" />
            {report.ask.length === 1 ? '1 field needs an answer' : `${report.ask.length} fields need an answer`}
          </p>
          <ul className="space-y-1.5">
            {report.ask.map((plan) => (
              <MissingInfoCard key={plan.field.id} plan={plan} />
            ))}
          </ul>
        </div>
      )}

      {report && report.validationErrors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-2">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-red-700">
            <Icon name="alert" className="h-3.5 w-3.5" />
            Page validation errors
          </p>
          <ul className="space-y-0.5">
            {report.validationErrors.slice(0, 6).map((error, index) => (
              <li key={`${error.fieldId ?? 'page'}-${index}`} className="text-2xs text-red-700">
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report && report.filled.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
          <summary className="cursor-pointer text-2xs font-medium text-slate-600">
            {report.filled.length} field{report.filled.length === 1 ? '' : 's'} filled
          </summary>
          <ul className="mt-1.5 space-y-1">
            {report.filled.map((outcome) => (
              <li key={outcome.fieldId} className="flex items-start gap-1.5">
                <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                <span className="min-w-0 flex-1 truncate text-2xs text-slate-600">
                  {outcome.actualValue || '(empty)'}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {optionalOpen.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-slate-700">
            {optionalOpen.length} optional field{optionalOpen.length === 1 ? '' : 's'} without a saved value
          </p>
          <ul className="space-y-1.5">
            {optionalOpen.map((plan) => (
              <MissingInfoCard key={plan.field.id} plan={plan} />
            ))}
          </ul>
        </div>
      )}

      {report && settled.length > 0 && (
        <div>
          <button
            onClick={() => setShowSkipped((value) => !value)}
            className="text-2xs font-medium text-slate-500 hover:text-slate-700"
          >
            {showSkipped ? 'Hide' : 'Show'} {settled.length} skipped field
            {settled.length === 1 ? '' : 's'}
          </button>
          {showSkipped && (
            <ul className="mt-1.5 space-y-1">
              {settled.map((plan) => (
                <li key={plan.field.id} className="rounded border border-slate-200 px-2 py-1.5">
                  <p className="truncate text-2xs font-medium text-slate-700">{plan.field.label}</p>
                  <p className="text-2xs text-slate-400">{plan.reason}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <NavigationSection />
    </div>
  )
}

function ReportSummary({ report }: { report: AutofillReport }) {
  const outstanding = report.ask.length
  const percent = report.totalFields ? (report.completedFields / report.totalFields) * 100 : 0

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-slate-900">
          {report.completedFields} / {report.totalFields}
        </span>
        <span className="text-xs text-slate-500">fields completed</span>
        <Badge tone={outstanding ? 'amber' : 'green'}>
          {outstanding ? `${outstanding} to answer` : 'All answered'}
        </Badge>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div
          className={cx('h-full rounded-full', outstanding ? 'bg-amber-400' : 'bg-emerald-500')}
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="text-2xs text-slate-400">
        {report.outstandingRequired} of {report.requiredFields} required still empty &middot; scanned{' '}
        {relativeTime(report.scannedAt)}
      </p>
    </div>
  )
}
