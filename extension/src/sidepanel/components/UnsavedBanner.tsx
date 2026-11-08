import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { Button, Icon } from './ui'

/**
 * Shown whenever the CSV working copy has drifted from the file on disk.
 *
 * This is the one piece of state a CSV source has that a live spreadsheet does not,
 * and leaving it implicit is how someone ends up re-applying to a job they already
 * did because their file never got the update.
 */
export function UnsavedBanner() {
  const { sourceStatus, preferences, saveCsv, busy } = useAppState()
  const [saved, setSaved] = useState<string | null>(null)

  const unsaved = sourceStatus?.unsavedChanges ?? 0
  if (preferences.jobSourceId !== 'csv' || unsaved === 0) return null

  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2">
      <Icon name="alert" className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <p className="flex-1 text-2xs leading-relaxed text-amber-800">
        {saved ?? (
          <>
            {unsaved} change{unsaved === 1 ? '' : 's'} not yet written to{' '}
            <span className="font-medium">{sourceStatus?.detail ?? 'your file'}</span>.
          </>
        )}
      </p>
      <Button
        size="sm"
        variant="secondary"
        loading={busy === 'saveCsv'}
        onClick={() => {
          void saveCsv().then((result) => {
            if (result) setSaved(`Saved to ${result.fileName}.`)
          })
        }}
      >
        Save
      </Button>
    </div>
  )
}
