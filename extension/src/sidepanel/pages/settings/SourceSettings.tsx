import { useAppState } from '../../state/AppStateContext'
import { CsvSettings } from './CsvSettings'
import { SheetSettings } from './SheetSettings'
import { SheetLinkSettings } from './SheetLinkSettings'
import { JOB_SOURCE_OPTIONS } from '@/jobsource'
import { Card, cx } from '../../components/ui'
import type { JobSourceId } from '@/shared/types/source'

export function SourceSettings() {
  const { preferences, setPreference } = useAppState()

  return (
    <div className="space-y-3">
      <Card className="p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Job source</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Where your job list is read from, and written back to when you press Done.
        </p>

        <div className="mt-3 space-y-1.5">
          {JOB_SOURCE_OPTIONS.map((option) => {
            const selected = preferences.jobSourceId === option.id
            return (
              <button
                key={option.id}
                onClick={() => void setPreference('jobSourceId', option.id as JobSourceId)}
                className={cx(
                  'flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors',
                  selected
                    ? 'border-brand-300 bg-brand-50/60'
                    : 'border-slate-200 bg-white hover:border-slate-300',
                )}
              >
                <span
                  className={cx(
                    'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-brand-600' : 'border-slate-300',
                  )}
                >
                  {selected && <span className="h-1.5 w-1.5 rounded-full bg-brand-600" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-slate-800">{option.label}</span>
                  <span className="block text-2xs text-slate-500">{option.note}</span>
                </span>
              </button>
            )
          })}
        </div>
      </Card>

      {preferences.jobSourceId === 'csv' ? (
        <CsvSettings />
      ) : preferences.jobSourceId === 'sheet-link' ? (
        <SheetLinkSettings />
      ) : (
        <SheetSettings />
      )}
    </div>
  )
}
