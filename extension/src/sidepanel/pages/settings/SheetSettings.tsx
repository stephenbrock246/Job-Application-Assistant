import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import { COLUMN_HEADER_ALIASES, COLUMN_LABELS, COLUMN_ORDER } from '@/shared/constants/sheet'
import { parseSpreadsheetId } from '@/shared/utils/format'
import { MessageError, sendMessage } from '@/shared/utils/messaging'
import { sheetConfigSlot } from '@/storage/settings'
import { Badge, Button, Card, ErrorBanner, Field, Icon, PhaseNotice, Select, TextInput } from '../../components/ui'
import type { SheetTab } from '@/shared/types/sheet'

export function SheetSettings() {
  const { account, sheetConfig, connectGoogle, disconnectGoogle, refreshQueue, busy } = useAppState()

  const [urlInput, setUrlInput] = useState('')
  const [tabs, setTabs] = useState<SheetTab[] | null>(null)
  const [sheetName, setSheetName] = useState('')
  const [headerRow, setHeaderRow] = useState('1')
  const [status, setStatus] = useState<'idle' | 'inspecting' | 'connecting'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [connectedMessage, setConnectedMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!sheetConfig) return
    setUrlInput((current) => current || sheetConfig.spreadsheetId)
    setSheetName((current) => current || sheetConfig.sheetName)
    setHeaderRow(String(sheetConfig.headerRow))
  }, [sheetConfig])

  const spreadsheetId = parseSpreadsheetId(urlInput)

  const handleError = (err: unknown) => {
    setError(err instanceof MessageError || err instanceof Error ? err.message : 'Something went wrong.')
  }

  const onInspect = async () => {
    setError(null)
    setConnectedMessage(null)
    setStatus('inspecting')
    try {
      const info = await sendMessage('sheets/inspect', { spreadsheetId })
      setTabs(info.tabs)
      if (!sheetName && info.tabs[0]) setSheetName(info.tabs[0].title)
    } catch (err) {
      handleError(err)
      setTabs(null)
    } finally {
      setStatus('idle')
    }
  }

  const onConnect = async () => {
    setError(null)
    setConnectedMessage(null)
    setStatus('connecting')
    try {
      const result = await sendMessage('sheets/connect', {
        spreadsheetId,
        sheetName,
        headerRow: Number(headerRow) || 1,
      })
      setConnectedMessage(
        result.missing.length
          ? `Connected. Note: no ${result.missing.join(', ')} column was found, so those values cannot be written back.`
          : 'Connected. All expected columns were found.',
      )
      await refreshQueue(true)
    } catch (err) {
      handleError(err)
    } finally {
      setStatus('idle')
    }
  }

  const onDisconnectSheet = async () => {
    await sheetConfigSlot.clear()
    setTabs(null)
    setConnectedMessage(null)
  }

  if (!account) {
    return (
      <div className="space-y-3">
        <Card className="p-3">
          <h2 className="text-[13px] font-semibold text-slate-900">Google account</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            Sign in through Chrome to read and update your job sheet. The extension never sees your
            password - Chrome holds the token, and only the spreadsheet scope is requested.
          </p>
          <Button className="mt-3" size="sm" onClick={() => void connectGoogle()} loading={busy === 'connect'}>
            Connect Google account
          </Button>
        </Card>

        <PhaseNotice phase="First run?">
          A Google Cloud OAuth client ID must be set in the manifest before sign-in works. See
          "Google Cloud setup" in the README.
        </PhaseNotice>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <Card className="p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold text-slate-900">Google account</h2>
            <p className="truncate text-xs text-slate-500">{account.email || 'Signed in'}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void disconnectGoogle()} loading={busy === 'disconnect'}>
            Sign out
          </Button>
        </div>
      </Card>

      <Card className="space-y-2.5 p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Spreadsheet</h2>

        <Field label="Sheet URL or ID" hint="Paste the full Google Sheets link; the ID is extracted for you.">
          <TextInput
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            placeholder="https://docs.google.com/spreadsheets/d/..."
          />
        </Field>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onInspect()}
          loading={status === 'inspecting'}
          disabled={!spreadsheetId}
        >
          Load tabs
        </Button>

        {tabs && (
          <>
            <Field label="Tab">
              <Select value={sheetName} onChange={(event) => setSheetName(event.target.value)}>
                {tabs.map((tab) => (
                  <option key={tab.sheetId} value={tab.title}>
                    {tab.title}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Header row" hint="The row that holds Date / Job Link / Company / ...">
              <TextInput
                type="number"
                min={1}
                value={headerRow}
                onChange={(event) => setHeaderRow(event.target.value)}
              />
            </Field>

            <Button size="sm" onClick={() => void onConnect()} loading={status === 'connecting'} disabled={!sheetName}>
              Connect sheet
            </Button>
          </>
        )}

        {connectedMessage && (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-2xs leading-relaxed text-emerald-800">
            {connectedMessage}
          </p>
        )}
      </Card>

      {sheetConfig?.spreadsheetId && (
        <Card className="p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-[13px] font-semibold text-slate-900">
                {sheetConfig.spreadsheetTitle || 'Connected sheet'}
              </h2>
              <p className="truncate text-2xs text-slate-500">
                {sheetConfig.sheetName} &middot; headers on row {sheetConfig.headerRow}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void onDisconnectSheet()}>
              Forget
            </Button>
          </div>

          <h3 className="mb-1.5 mt-3 text-2xs font-semibold uppercase tracking-wide text-slate-500">
            Column mapping
          </h3>
          <ul className="space-y-1">
            {COLUMN_ORDER.map((key) => {
              const index = sheetConfig.columnMap?.[key]
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
                      {sheetConfig.detectedHeaders?.[index] ?? `col ${index + 1}`}
                    </Badge>
                  ) : (
                    <span className="text-2xs text-slate-400">not found</span>
                  )}
                </li>
              )
            })}
          </ul>

          <p className="mt-2 text-2xs leading-relaxed text-slate-400">
            Columns are matched by header name, not position, so inserting a column will not break
            write-back. Accepted spellings for Status include: {COLUMN_HEADER_ALIASES.status.join(', ')}.
          </p>
        </Card>
      )}
    </div>
  )
}
