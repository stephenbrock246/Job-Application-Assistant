import type { SessionStatus } from '@/shared/types/application'
import { Icon, cx } from './ui'

const STEPS = [
  { key: 'analyze', label: 'Analyze job' },
  { key: 'resume', label: 'Tailor resume' },
  { key: 'fill', label: 'Fill form' },
  { key: 'review', label: 'Review' },
] as const

/** Maps session status onto the four-step indicator from the mockup. */
function activeIndex(status: SessionStatus): number {
  switch (status) {
    case 'ANALYZING':
      return 0
    case 'RESUME_REVIEW':
      return 1
    case 'APPLYING':
    case 'NEEDS_INPUT':
      return 2
    case 'REVIEW':
    case 'SUBMITTED':
      return 3
  }
}

export function ProgressStepper({ status }: { status: SessionStatus }) {
  const current = activeIndex(status)

  return (
    <div className="flex items-start">
      {STEPS.map((step, index) => {
        const done = index < current
        const active = index === current
        return (
          <div key={step.key} className="flex flex-1 flex-col items-center">
            <div className="flex w-full items-center">
              <Line filled={index > 0 && (done || active)} hidden={index === 0} />
              <span
                className={cx(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold',
                  done && 'border-emerald-500 bg-emerald-500 text-white',
                  active && 'border-brand-500 bg-brand-500 text-white',
                  !done && !active && 'border-slate-300 bg-white text-slate-400',
                )}
              >
                {done ? <Icon name="check" className="h-3 w-3" /> : index + 1}
              </span>
              <Line filled={done} hidden={index === STEPS.length - 1} />
            </div>
            <span
              className={cx(
                'mt-1 text-center text-2xs leading-tight',
                active ? 'font-medium text-slate-700' : 'text-slate-400',
              )}
            >
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Line({ filled, hidden }: { filled: boolean; hidden: boolean }) {
  return (
    <span
      className={cx(
        'h-px flex-1',
        hidden ? 'bg-transparent' : filled ? 'bg-emerald-400' : 'bg-slate-200',
      )}
    />
  )
}
