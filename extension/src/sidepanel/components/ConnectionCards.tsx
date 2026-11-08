import { useAppState } from '../state/AppStateContext'
import { Dot, Icon, cx } from './ui'

/**
 * The two status cards at the top of the mockup. They report real state:
 * "Connected" means we hold a live Google token *and* a configured sheet.
 */
export function ConnectionCards({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { sourceStatus, queue, aiStatus, loadingQueue } = useAppState()

  const detail = loadingQueue
    ? 'Loading...'
    : sourceStatus?.connected
      ? `${sourceStatus.detail}${queue ? ` · ${queue.counts.total} rows` : ''}`
      : (sourceStatus?.detail ?? 'Not configured')

  const unsaved = sourceStatus?.unsavedChanges ?? 0

  return (
    <div className="grid grid-cols-2 gap-2">
      <StatusCard
        icon={<Icon name="sheet" className="h-4 w-4 text-emerald-600" />}
        title={sourceStatus?.label ?? 'Job source'}
        connected={sourceStatus?.connected ?? false}
        detail={detail}
        badge={unsaved > 0 ? `${unsaved} unsaved` : undefined}
        onClick={() => onOpenSettings('source')}
      />
      <StatusCard
        icon={<Icon name="sparkle" className="h-4 w-4 text-orange-500" />}
        title="AI Provider"
        connected={aiStatus?.ready ?? false}
        detail={aiStatus?.detail ?? 'Checking...'}
        onClick={() => onOpenSettings('ai')}
      />
    </div>
  )
}

function StatusCard({
  icon,
  title,
  connected,
  detail,
  badge,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  connected: boolean
  detail: string
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="card flex flex-col gap-1 px-2.5 py-2 text-left transition-colors hover:border-slate-300"
    >
      <span className="flex items-center gap-1.5">
        {icon}
        <span className="truncate text-xs font-semibold text-slate-800">{title}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Dot tone={connected ? 'green' : 'amber'} />
        <span className={cx('text-2xs font-medium', connected ? 'text-emerald-600' : 'text-amber-600')}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </span>
      {badge ? (
        <span className="truncate rounded bg-amber-50 px-1 py-px text-2xs font-medium text-amber-700">
          {badge}
        </span>
      ) : (
        <span className="truncate text-2xs text-slate-400" title={detail}>
          {detail}
        </span>
      )}
    </button>
  )
}
