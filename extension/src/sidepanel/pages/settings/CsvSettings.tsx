import { useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { jobTableSlot } from '@/storage/job-table'
import { pickCsvFile, isAbort, forgetCsvHandle } from '../../lib/csv-file'
import { supportsFileSystemAccess } from '../../lib/file-handles'
import { COLUMN_HEADER_ALIASES, COLUMN_LABELS, COLUMN_ORDER } from '@/shared/constants/sheet'
import { MessageError, sendMessage } from '@/shared/utils/messaging'
import { relativeTime } from '@/shared/utils/format'
import {
  Badge,
  Button,
  Card,
  ErrorBanner,
  Icon,
  PhaseNotice,
  Toggle,
} from '../../components/ui'
import type { LocalJobTable } from '@/shared/types/source'

export function CsvSettings() {
  const { preferences, setPreference, refreshQueue, refreshSourceStatus, sourceStatus, saveCsv, busy } =
    useAppState()
  const [table] = useStorageSlot(jobTableSlot, null as LocalJobTable | null)

  const [addMissingColumns, setAddMissingColumns] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const onImport = async () => {
    setError(null)
    setNote(null)
    setImporting(true)
    try {
      const picked = await pickCsvFile()
      if (!picked) return

      const result = await sendMessage('csv/import', {
        fileName: picked.fileName,
        text: picked.text,
        addMissingColumns,
        hasFileHandle: picked.hasFileHandle,
      })

      const parts = [`Loaded ${result.jobCount} job${result.jobCount === 1 ? '' : 's'}.`]
      if (result.addedColumns.length) {
        parts.push(`Added missing column(s): ${result.addedColumns.join(', ')}.`)
      }
      if (result.missingColumns.length) {
        parts.push(
          `No ${result.missingColumns.join(', ')} column, so those values cannot be recorded.`,
        )
      }
      if (!picked.hasFileHandle) {
        parts.push('Saving will download a new copy rather than overwriting the original.')
      }
      setNote(parts.join(' '))

      await refreshSourceStatus()
      await refreshQueue(true)
    } catch (err) {
      if (!isAbort(err)) {
        setError(err instanceof MessageError || err instanceof Error ? err.message : 'Import failed.')
      }
    } finally {
      setImporting(false)
    }
  }

  const onSave = async () => {
    setError(null)
    setNote(null)
    const result = await saveCsv()
    if (!result) return
    setNote(
      result.method === 'in-place'
        ? `Saved to ${result.fileName}.`
        : result.method === 'save-as'
          ? `Saved as ${result.fileName}. Future saves will overwrite that file directly.`
          : `Downloaded ${result.fileName}. Replace your original file with it.`,
    )
    await refreshSourceStatus()
  }

  const unsaved = sourceStatus?.unsavedChanges ?? 0

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card className="space-y-2.5 p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">CSV file</h2>
        <p className="text-xs leading-relaxed text-slate-600">
          The extension keeps a working copy of your file. Edits are applied instantly; saving writes
          them back.
        </p>

        <Toggle
          label="Add any missing columns on import"
          hint="Appends Applied Date / Resume / Other if your file lacks them, so Done can record everything."
          checked={addMissingColumns}
          onChange={setAddMissingColumns}
        />

        <Button size="sm" onClick={() => void onImport()} loading={importing}>
          <Icon name="file" className="h-3.5 w-3.5" />
          {table ? 'Import a different file' : 'Import CSV file'}
        </Button>

        {note && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-2xs leading-relaxed text-emerald-800">
            {note}
          </p>
        )}

        {!supportsFileSystemAccess() && (
          <PhaseNotice phase="Heads up.">
            This browser does not offer direct file writing, so saving produces a download that you
            replace your original with.
          </PhaseNotice>
        )}
      </Card>

      {table && (
        <>
          <Card className="space-y-2.5 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-[13px] font-semibold text-slate-900">
                  {table.fileName}
                </h2>
                <p className="truncate text-2xs text-slate-500">
                  imported {relativeTime(table.importedAt)} &middot; headers on row{' '}
                  {table.headerRowIndex + 1} &middot; {describeDelimiter(table.delimiter)}
                </p>
              </div>
              {unsaved > 0 ? (
                <Badge tone="amber">{unsaved} unsaved</Badge>
              ) : (
                <Badge tone="green">saved</Badge>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={unsaved > 0 ? 'primary' : 'secondary'}
                onClick={() => void onSave()}
                loading={busy === 'saveCsv'}
              >
                Save CSV
              </Button>
              <span className="text-2xs text-slate-400">
                {table.lastSavedAt ? `last saved ${relativeTime(table.lastSavedAt)}` : 'not saved yet'}
              </span>
            </div>

            {table.hasFileHandle ? (
              <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-slate-500">
                <Icon name="check" className="mt-px h-3 w-3 shrink-0 text-emerald-500" />
                Saving overwrites your original file directly.
                <button
                  onClick={() => void forgetCsvHandle().then(refreshSourceStatus)}
                  className="underline underline-offset-2 hover:text-slate-700"
                >
                  Forget file
                </button>
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-amber-700">
                <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
                No write access to the original file - saving will ask you where to put it.
              </p>
            )}

            <Toggle
              label="Save automatically after each change"
              hint="Only runs when the original file can be overwritten without a prompt."
              checked={preferences.autoSaveCsv}
              onChange={(value) => void setPreference('autoSaveCsv', value)}
            />
          </Card>

          <Card className="p-3">
            <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-slate-500">
              Column mapping
            </h3>
            <ul className="space-y-1">
              {COLUMN_ORDER.map((key) => {
                const index = table.columnMap[key]
                const found = index !== undefined
                return (
                  <li key={key} className="flex items-center gap-2 text-xs">
                    <Icon
                      name={found ? 'check' : 'close'}
                      className={found ? 'h-3.5 w-3.5 text-emerald-500' : 'h-3.5 w-3.5 text-slate-300'}
                    />
                    <span className="flex-1 text-slate-600">{COLUMN_LABELS[key]}</span>
                    {found ? (
                      <Badge tone="neutral">
                        {table.records[table.headerRowIndex]?.[index] ?? `col ${index + 1}`}
                      </Badge>
                    ) : (
                      <span className="text-2xs text-slate-400">not found</span>
                    )}
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-2xs leading-relaxed text-slate-400">
              Columns are matched by header name, not position. Accepted spellings for Status
              include: {COLUMN_HEADER_ALIASES.status.join(', ')}.
            </p>
          </Card>
        </>
      )}
    </div>
  )
}

function describeDelimiter(delimiter: string): string {
  if (delimiter === ',') return 'comma separated'
  if (delimiter === ';') return 'semicolon separated'
  if (delimiter === '\t') return 'tab separated'
  return `"${delimiter}" separated`
}
