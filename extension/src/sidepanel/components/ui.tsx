/** Small presentational primitives shared across the panel. */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'ghost' | 'danger'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-200',
  secondary:
    'border border-brand-200 bg-white text-brand-700 hover:bg-brand-50 disabled:border-slate-200 disabled:text-slate-400',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-200',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
  danger:
    'border border-red-200 bg-white text-red-600 hover:bg-red-50 disabled:border-slate-200 disabled:text-slate-400',
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
  /** While loading, shows a Cancel button next to this one that calls this. */
  onCancel?: () => void
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  onCancel,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  if (loading && onCancel) {
    return (
      <span className={cx('inline-flex items-stretch gap-1.5', className?.includes('w-full') && 'w-full')}>
        <Button variant={variant} size={size} loading className={cx(className, 'min-w-0 flex-1')} {...props}>
          {children}
        </Button>
        <CancelButton onClick={onCancel} size={size} />
      </span>
    )
  }

  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-[13px]',
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Spinner />}
      {children}
    </button>
  )
}

export function CancelButton({ onClick, size = 'sm' }: { onClick: () => void; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white font-medium text-slate-600 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-700',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-2 text-[13px]',
      )}
    >
      <Icon name="close" className="h-3 w-3" />
      Cancel
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('h-3.5 w-3.5 animate-spin', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('card', className)}>{children}</div>
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between px-0.5">
      <h2 className="text-xs font-semibold text-slate-700">{children}</h2>
      {action}
    </div>
  )
}

/** A small heading inside a card ("CV", "Cover letter"), with an optional badge or action on the right. */
export function SubTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-slate-800">{children}</span>
      {right}
    </div>
  )
}

/** An inline text action ("Edit", "Regenerate") - quieter than a button. */
export function TextButton({
  className,
  tone = 'brand',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'brand' | 'muted' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'shrink-0 rounded text-2xs font-medium underline-offset-2 transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline',
        tone === 'brand' ? 'text-brand-600 hover:text-brand-700' : 'text-slate-500 hover:text-slate-700',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** A one-line notice: amber for "check this", red for "blocked", slate for information. */
export function Notice({ tone = 'amber', children }: { tone?: 'amber' | 'red' | 'slate' | 'green'; children: ReactNode }) {
  const styles = {
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-700',
    slate: 'border-slate-200 bg-slate-50 text-slate-600',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[tone]
  return (
    <div className={cx('flex items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-2xs leading-relaxed', styles)}>
      <Icon name={tone === 'green' ? 'check' : tone === 'slate' ? 'info' : 'alert'} className="mt-px h-3 w-3 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

type Tone = 'neutral' | 'green' | 'blue' | 'amber' | 'red'

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-600',
  green: 'bg-emerald-50 text-emerald-700',
  blue: 'bg-brand-50 text-brand-700',
  amber: 'bg-amber-50 text-amber-700',
  red: 'bg-red-50 text-red-600',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cx('inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium', TONES[tone])}>
      {children}
    </span>
  )
}

const DOT_TONES: Record<Tone, string> = {
  neutral: 'bg-slate-400',
  green: 'bg-emerald-500',
  blue: 'bg-brand-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
}

export function Dot({ tone = 'neutral' }: { tone?: Tone }) {
  return <span className={cx('inline-block h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONES[tone])} />
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-2xs text-slate-400">{hint}</span>}
    </label>
  )
}

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx('input', className)} />
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx('input resize-y', className)} />
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx('input pr-7', className)}>
      {children}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
      <span>
        <span className="block text-[13px] text-slate-700">{label}</span>
        {hint && <span className="block text-2xs text-slate-400">{hint}</span>}
      </span>
    </label>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white/60 px-4 py-6 text-center">
      <p className="text-[13px] font-medium text-slate-700">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{description}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button onClick={onDismiss} className="shrink-0 text-red-400 hover:text-red-600" aria-label="Dismiss">
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/** Notice used wherever a later-phase capability is intentionally not wired up yet. */
export function PhaseNotice({ phase, children }: { phase: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-2xs text-slate-500">
      <Icon name="info" className="mt-px h-3.5 w-3.5 shrink-0 text-slate-400" />
      <p className="leading-relaxed">
        <span className="font-medium text-slate-600">{phase}</span> {children}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Icons (inline so the panel ships no icon font or sprite request)
// ---------------------------------------------------------------------------

const PATHS: Record<string, ReactNode> = {
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="m20 6-11 11-5-5" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </>
  ),
  external: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </>
  ),
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </>
  ),
  back: <path d="m15 18-6-6 6-6" />,
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  sheet: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </>
  ),
  sparkle: (
    <>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="m5.6 5.6 2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </>
  ),
}

export function Icon({ name, className }: { name: keyof typeof PATHS | string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('h-4 w-4', className)}
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  )
}
