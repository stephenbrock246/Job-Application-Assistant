import { useAppState } from '../state/AppStateContext'
import { relativeTime } from '@/shared/utils/format'
import { Dot, Icon, Spinner, cx } from './ui'

/**
 * One bar: queue counts, refresh, settings. A source that is not connected is the
 * only status worth a line of its own.
 */
export function Header({ onOpenSettings }: { onOpenSettings: (tab?: string) => void }) {
  const { queue, loadingQueue, refreshQueue, sourceStatus } = useAppState()
  const counts = queue?.counts

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-white">
          <Icon name="briefcase" className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-tight text-slate-900">JobApply</p>
          <div className="flex items-center gap-2.5 text-2xs">
            <Count tone="blue" value={counts?.ready} label="ready" />
            <Count tone="amber" value={counts?.inProgress} label="in progress" />
            <Count tone="green" value={counts?.applied} label="applied" />
          </div>
        </div>
        <IconButton
          title={queue ? `Refresh (last ${relativeTime(queue.fetchedAt)})` : 'Refresh'}
          onClick={() => void refreshQueue(true)}
        >
          {loadingQueue ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
        </IconButton>
        <IconButton title="Settings" onClick={() => onOpenSettings()}>
          <Icon name="settings" className="h-4 w-4" />
        </IconButton>
      </div>

      {sourceStatus && !sourceStatus.connected && (
        <button
          onClick={() => onOpenSettings('source')}
          className="flex w-full items-center gap-1.5 border-t border-amber-100 bg-amber-50 px-3 py-1.5 text-left text-2xs text-amber-800"
        >
          <Icon name="alert" className="h-3 w-3 shrink-0" />
          {sourceStatus.detail || 'Connect your job list in Settings'}
        </button>
      )}
    </header>
  )
}

function Count({ tone, value, label }: { tone: 'blue' | 'green' | 'amber'; value: number | undefined; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <Dot tone={tone} />
      <span className="font-semibold text-slate-700">{value ?? 0}</span>
      <span className="text-slate-500">{label}</span>
    </span>
  )
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={cx('rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800')}
    >
      {children}
    </button>
  )
}
