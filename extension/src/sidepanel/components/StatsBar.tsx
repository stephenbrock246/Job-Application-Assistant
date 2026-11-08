import { useAppState } from '../state/AppStateContext'
import { relativeTime } from '@/shared/utils/format'
import { Button, Dot, Icon } from './ui'

/** The "12 Ready / 4 Done / 2 Need info" row plus the refresh control. */
export function StatsBar() {
  const { queue, loadingQueue, refreshQueue, session } = useAppState()
  const counts = queue?.counts
  const needsInfo = session?.lastReport?.ask.length ?? 0

  return (
    <div className="flex items-center gap-2.5 px-0.5">
      <div className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <Stat tone="blue" value={counts?.ready ?? 0} label="Ready" />
        <Stat tone="green" value={counts?.applied ?? 0} label="Applied" />
        <Stat tone="amber" value={counts?.inProgress ?? 0} label="In progress" />
        {needsInfo > 0 && <Stat tone="red" value={needsInfo} label="Need info" />}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void refreshQueue(true)}
        loading={loadingQueue}
        title={queue ? `Last refreshed ${relativeTime(queue.fetchedAt)}` : 'Refresh the queue'}
      >
        {!loadingQueue && <Icon name="refresh" className="h-3 w-3" />}
        Refresh
      </Button>
    </div>
  )
}

function Stat({
  tone,
  value,
  label,
}: {
  tone: 'blue' | 'green' | 'amber' | 'red'
  value: number
  label: string
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <Dot tone={tone} />
      <span className="text-xs font-semibold text-slate-800">{value}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </span>
  )
}
