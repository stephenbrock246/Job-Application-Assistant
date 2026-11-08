/**
 * What was put into the form automatically: each upload and the pasted cover
 * letter, with the reason when the page refused one.
 */

import { useAppState } from '../state/AppStateContext'
import { jobFolderName } from '@/shared/utils/format'
import { Icon, cx } from './ui'

export function AutopilotStatus() {
  const { session } = useAppState()
  if (!session) return null
  const entries = Object.values(session.autopilot?.attached ?? {})
  if (!entries.length) return null

  return (
    <ul className="space-y-1 px-3 pb-2.5">
      {entries.map((entry) => (
        <li key={`${entry.fileName}-${entry.at}`} className="flex items-start gap-1.5 text-2xs">
          <Icon
            name={entry.ok ? 'check' : 'alert'}
            className={cx('mt-px h-3 w-3 shrink-0', entry.ok ? 'text-emerald-500' : 'text-amber-500')}
          />
          <span className={entry.ok ? 'text-slate-600' : 'text-amber-800'}>
            {entry.ok
              ? `${entry.fileName === 'the cover letter text' ? 'Pasted' : 'Uploaded'} ${entry.fileName}`
              : `Could not add ${entry.fileName || 'the file'}${entry.note ? ` (${entry.note})` : ''} - add it from Downloads/JobApply/${jobFolderName(session.company, session.position)}.`}
          </span>
        </li>
      ))}
    </ul>
  )
}
