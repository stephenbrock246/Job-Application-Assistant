import { useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { fetchSheetRows, parseSheetUrl, sheetLinkSlot } from '@/jobsource/sheet-link/sheet-link.source'
import { findHeaderRow } from '@/jobsource/csv/csv.source'
import { buildColumnMap, missingRequiredColumns, parseRows } from '@/jobsource/row-parser'
import { COLUMN_LABELS, COLUMN_ORDER } from '@/shared/constants/sheet'
import { Badge, Button, Card, Field, TextInput } from '../../components/ui'
import type { SheetLinkConfig } from '@/shared/types/source'

/**
 * Connect a Google Sheet by pasting its link. The sheet is read live on every
 * refresh; nothing is downloaded or stored except the link itself.
 */
export function SheetLinkSettings() {
  const { refreshQueue, refreshSourceStatus } = useAppState()
  const [config, setConfig] = useStorageSlot(sheetLinkSlot, null as SheetLinkConfig | null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string; headers?: string[] } | null>(null)

  const connect = async () => {
    const parsed = parseSheetUrl(url || config?.url || '')
    if (!parsed) {
      setResult({ ok: false, text: 'That is not a Google Sheets link. Copy it from the browser address bar while the sheet is open.' })
      return
    }
    setBusy(true)
    setResult(null)
    try {
      const records = await fetchSheetRows(parsed)
      const headerRowIndex = findHeaderRow(records)
      const headers = records[headerRowIndex] ?? []
      const columnMap = buildColumnMap(headers)
      const missing = missingRequiredColumns(columnMap)
      if (missing.length) {
        throw new Error(`The sheet has no ${missing.map((key) => COLUMN_LABELS[key]).join(' / ')} column. Check the header row.`)
      }
      const jobs = parseRows(records, headerRowIndex, columnMap, 'check')
      await setConfig({ url: url || config!.url, ...parsed, connectedAt: Date.now(), columnMap })
      setUrl('')
      const found = COLUMN_ORDER.filter((key) => columnMap[key] !== undefined).map((key) => COLUMN_LABELS[key])
      setResult({ ok: true, text: `Connected: ${jobs.length} jobs, header on row ${headerRowIndex + 1}.`, headers: found })
      await refreshSourceStatus()
      await refreshQueue(true)
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : 'Could not read the sheet.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="space-y-2.5 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">Google Sheet link</h2>
        <Badge tone={config ? 'green' : 'neutral'}>{config ? 'Connected' : 'Not connected'}</Badge>
      </div>
      <ol className="list-decimal space-y-0.5 pl-4 text-2xs leading-relaxed text-slate-600">
        <li>In your sheet: <span className="font-medium">Share</span> &rarr; General access &rarr; <span className="font-medium">Anyone with the link</span> &rarr; Viewer.</li>
        <li>Copy the address from the browser bar (open the right tab first) and paste it here.</li>
      </ol>
      <p className="text-2xs leading-relaxed text-slate-500">
        The sheet is read live every time the queue refreshes - nothing is downloaded. When you press Done or
        Skip, the job leaves your queue at once and the panel lists what to type into the sheet.
      </p>

      {config && (
        <p className="truncate text-2xs text-slate-500" title={config.url}>
          Current: {config.url}
        </p>
      )}
      <Field label={config ? 'Change sheet link' : 'Sheet link'}>
        <TextInput
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://docs.google.com/spreadsheets/d/.../edit#gid=0"
        />
      </Field>
      <Button size="sm" loading={busy} disabled={!url.trim() && !config} onClick={() => void connect()}>
        {config && !url.trim() ? 'Re-check sheet' : 'Connect'}
      </Button>

      {result && (
        <div
          className={
            result.ok
              ? 'rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-2xs text-emerald-800'
              : 'rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-2xs text-red-700'
          }
        >
          <p>{result.text}</p>
          {result.headers && <p className="mt-0.5">Columns found: {result.headers.join(', ')}</p>}
        </div>
      )}
    </Card>
  )
}
