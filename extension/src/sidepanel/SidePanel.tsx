import { useState } from 'react'
import { Header } from './components/Header'
import { JobQueue } from './components/JobQueue'
import { CurrentApplication } from './components/CurrentApplication'
import { RunPanel } from './components/RunPanel'
import { UnsavedBanner } from './components/UnsavedBanner'
import { SettingsPage, type SettingsTab } from './pages/SettingsPage'
import { useAppState } from './state/AppStateContext'
import { useAutopilot } from './hooks/useAutopilot'
import { useDownloadedResume } from './hooks/useDownloadedResume'
import { useProfileFromResume } from './hooks/useProfileFromResume'
import { ErrorBanner, Spinner } from './components/ui'

export function SidePanel() {
  const { ready, error, dismissError, session } = useAppState()
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  // Mounted here, above the settings/main switch, so it keeps working while Settings is open.
  useAutopilot()
  useDownloadedResume()
  useProfileFromResume()

  if (settingsTab) {
    return <SettingsPage tab={settingsTab} onChangeTab={setSettingsTab} onClose={() => setSettingsTab(null)} />
  }

  const openSettings = (tab?: string) => setSettingsTab((tab as SettingsTab | undefined) ?? 'profile')

  return (
    <div className="flex h-full flex-col bg-slate-100">
      <Header onOpenSettings={openSettings} />

      <main className="flex-1 space-y-3 overflow-y-auto p-3">
        {error && <ErrorBanner message={error} onDismiss={dismissError} />}

        {!ready ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
            <Spinner />
            Loading
          </div>
        ) : (
          <>
            <UnsavedBanner />
            <RunPanel />
            {session && <CurrentApplication onOpenSettings={openSettings} />}
            <JobQueue onOpenSettings={openSettings} />
          </>
        )}
      </main>
    </div>
  )
}
