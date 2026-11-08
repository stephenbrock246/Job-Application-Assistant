/**
 * Every field on the current page, in one list - required (*) first, the empty ones
 * at the top. Nothing the scanner saw is left out, including controls it can only
 * list ("check on the page"). Click a row to jump to the field.
 */

import { useAppState } from '../state/AppStateContext'
import { Icon, cx } from './ui'
import type { ApplicationField } from '@/shared/types/application'

type Status = 'missing' | 'check' | 'filled' | 'empty'

function statusOf(field: ApplicationField): Status {
  if (field.valueUnknown) return 'check'
  if (field.value) return 'filled'
  return field.required ? 'missing' : 'empty'
}

const ORDER: Record<Status, number> = { missing: 0, check: 1, filled: 2, empty: 3 }

export function FieldChecklist({ fields }: { fields: ApplicationField[] }) {
  const { highlightField } = useAppState()
  if (!fields.length) return null

  const rows = [...fields].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1
    return ORDER[statusOf(a)] - ORDER[statusOf(b)]
  })
  const required = fields.filter((f) => f.required)
  const requiredDone = required.filter((f) => statusOf(f) === 'filled').length
  const missing = required.filter((f) => statusOf(f) === 'missing').length
  const toCheck = fields.filter((f) => statusOf(f) === 'check').length

  return (
    <details className="rounded-lg border border-slate-200 bg-white" open={missing + toCheck > 0}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-2xs font-medium text-slate-600">
        All {fields.length} fields on this page
        <span className="ml-auto flex items-center gap-2">
          <span className={missing ? 'text-red-600' : 'text-emerald-600'}>
            Required {requiredDone}/{required.length}
          </span>
          {toCheck > 0 && <span className="text-amber-700">{toCheck} to check</span>}
        </span>
      </summary>

      <ul className="divide-y divide-slate-100 border-t border-slate-100">
        {rows.map((field) => {
          const status = statusOf(field)
          return (
            <li key={field.id}>
              <button
                onClick={() => void highlightField(field.id)}
                title="Show me this field on the page"
                className={cx(
                  'flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50',
                  status === 'missing' && 'bg-red-50/50',
                  status === 'check' && 'bg-amber-50/50',
                )}
              >
                <StatusIcon status={status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-2xs text-slate-700">
                    {field.label.replace(/\s*\*\s*$/, '')}
                    {field.required && <span className="ml-0.5 text-red-500">*</span>}
                  </span>
                  <span
                    className={cx(
                      'block truncate text-2xs',
                      status === 'filled' ? 'text-slate-500' : status === 'missing' ? 'text-red-600' : 'text-amber-700',
                      status === 'empty' && 'text-slate-400',
                    )}
                  >
                    {status === 'filled'
                      ? field.type === 'checkbox'
                        ? 'Checked'
                        : field.value
                      : status === 'check'
                        ? 'Check on the page - cannot be read'
                        : status === 'missing'
                          ? field.custom
                            ? 'Empty - choose it on the page'
                            : 'Empty - needs an answer'
                          : 'Empty (optional)'}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'filled') return <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
  if (status === 'missing') return <Icon name="alert" className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
  if (status === 'check') return <Icon name="info" className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
  return <span className="mt-1 h-2 w-2 shrink-0 rounded-full border border-slate-300" />
}
