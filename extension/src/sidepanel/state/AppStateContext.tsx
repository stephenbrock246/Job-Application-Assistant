/**
 * Single source of truth for the side panel.
 *
 * The panel holds no authoritative state of its own: it mirrors the background
 * worker and chrome.storage, and re-reads on broadcast. That way two panels (or a
 * panel plus a reopened one) can never disagree about what has been applied to.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { MessageError, onBroadcast, sendMessage } from '@/shared/utils/messaging'
import { ACTIONABLE_STATUSES } from '@/shared/types/job'
import { preferencesSlot, sheetConfigSlot } from '@/storage/settings'
import { activeSessionIdSlot } from '@/storage/sessions'
import { DEFAULT_PREFERENCES } from '@/shared/constants/defaults'
import { isAbort, saveCsvFile, type SaveResult } from '../lib/csv-file'
import { reportPanelError } from '../lib/diagnostics'
import type { JobSourceStatus } from '@/shared/types/source'
import type { ApplicationSession } from '@/shared/types/application'
import type { AIProviderStatus } from '@/shared/types/ai'
import type { GoogleAccountInfo, Preferences } from '@/shared/types/settings'
import type { QueueSnapshot } from '@/shared/types/messages'
import type { SheetConfig } from '@/shared/types/sheet'
import type { SheetJob, SkipReason } from '@/shared/types/job'

interface AppState {
  ready: boolean
  account: GoogleAccountInfo | null
  sheetConfig: SheetConfig | null
  sourceStatus: JobSourceStatus | null
  preferences: Preferences
  queue: QueueSnapshot | null
  session: ApplicationSession | null
  aiStatus: AIProviderStatus | null

  /** Jobs shown in the queue, after the "hide completed" rule. */
  visibleJobs: SheetJob[]

  loadingQueue: boolean
  busy: string | null
  error: string | null

  connectGoogle: () => Promise<void>
  disconnectGoogle: () => Promise<void>
  refreshQueue: (force?: boolean) => Promise<void>
  openJob: (jobId: string) => Promise<void>
  focusJobTab: () => Promise<void>
  markDone: (notes?: string) => Promise<void>
  markFailed: (reason: SkipReason, notes?: string) => Promise<void>
  abandonSession: () => Promise<void>
  refreshJobInfo: () => Promise<void>
  scanPage: () => Promise<void>
  autofillPage: () => Promise<void>
  answerField: (input: {
    fieldId: string
    value: string
    saveAsDefault: boolean
    label: string
    canonicalField?: string
  }) => Promise<void>
  highlightField: (fieldId: string) => Promise<void>
  /** Clicks the page's Next/Continue and follows it. `force` skips the empty-required-fields check. */
  nextPage: (force?: boolean) => Promise<void>
  /** Stops a Next in progress (the panel stops waiting for the page). */
  cancelNext: () => Promise<void>
  /** Runs an arbitrary panel action with the shared busy label and error banner. */
  perform: (label: string, action: () => Promise<void>) => Promise<void>
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => Promise<void>
  refreshSourceStatus: () => Promise<void>
  refreshAiStatus: () => Promise<void>
  /** Saves the CSV working copy back to a file. Returns how it was saved. */
  saveCsv: () => Promise<SaveResult | null>
  dismissError: () => void
}

const AppStateContext = createContext<AppState | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [account, setAccount] = useState<GoogleAccountInfo | null>(null)
  const [sheetConfig, setSheetConfig] = useState<SheetConfig | null>(null)
  const [sourceStatus, setSourceStatus] = useState<JobSourceStatus | null>(null)
  const [preferences, setPreferences] = useState<Preferences>(DEFAULT_PREFERENCES)
  const [queue, setQueue] = useState<QueueSnapshot | null>(null)
  const [session, setSession] = useState<ApplicationSession | null>(null)
  const [aiStatus, setAiStatus] = useState<AIProviderStatus | null>(null)
  const [loadingQueue, setLoadingQueue] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const report = useCallback((err: unknown) => {
    const message =
      err instanceof MessageError || err instanceof Error ? err.message : 'Something went wrong.'
    if (mounted.current) setError(message)
    reportPanelError(err, 'panel:action')
  }, [])

  /** Wraps an action with a busy label and centralised error reporting. */
  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label)
      setError(null)
      try {
        await action()
      } catch (err) {
        report(err)
      } finally {
        if (mounted.current) setBusy(null)
      }
    },
    [report],
  )

  const loadSourceStatus = useCallback(async () => {
    try {
      const status = await sendMessage('source/status')
      if (mounted.current) setSourceStatus(status)
      return status
    } catch {
      if (mounted.current) setSourceStatus(null)
      return null
    }
  }, [])

  const loadQueue = useCallback(
    async (force = false) => {
      const status = await loadSourceStatus()
      if (!status?.connected) {
        if (mounted.current) setQueue(null)
        return
      }
      setLoadingQueue(true)
      try {
        const snapshot = await sendMessage('source/queue', { force })
        if (mounted.current) setQueue(snapshot)
      } catch (err) {
        report(err)
      } finally {
        if (mounted.current) setLoadingQueue(false)
      }
    },
    [report, loadSourceStatus],
  )

  const loadAiStatus = useCallback(async () => {
    try {
      const status = await sendMessage('ai/status')
      if (mounted.current) setAiStatus(status)
    } catch {
      /* the status card just shows "unavailable" */
    }
  }, [])

  // Initial load.
  useEffect(() => {
    void (async () => {
      const [config, prefs] = await Promise.all([sheetConfigSlot.get(), preferencesSlot.get()])
      if (!mounted.current) return
      setSheetConfig(config)
      setPreferences(prefs)

      try {
        const [acct, activeSession] = await Promise.all([
          sendMessage('auth/status'),
          sendMessage('session/active'),
        ])
        if (!mounted.current) return
        setAccount(acct)
        setSession(activeSession)
      } catch (err) {
        report(err)
      }

      void loadAiStatus()
      void loadQueue(false)
      if (mounted.current) setReady(true)
    })()
  }, [loadAiStatus, loadQueue, report])

  // Keep in sync with storage edits made on the Settings screen.
  useEffect(() => sheetConfigSlot.subscribe(setSheetConfig), [])
  useEffect(() => preferencesSlot.subscribe(setPreferences), [])
  useEffect(() => {
    void loadAiStatus()
  }, [preferences.aiProviderId, loadAiStatus])

  // The panel shows the *active* application only. The worker broadcasts updates
  // for every session it touches (an autopilot job in another window, a tab event),
  // so an update for any other session is ignored - showing it would let Done or
  // Autofill act on a job the user is not looking at. A change of the active
  // session (or a finished one) is read back from the worker.
  const sessionSeq = useRef(0)
  const showActive = useCallback(async (update?: ApplicationSession | null) => {
    const seq = ++sessionSeq.current
    const activeId = await activeSessionIdSlot.get()
    const next = update && update.id === activeId ? update : activeId ? await sendMessage('session/active') : null
    if (!mounted.current || seq !== sessionSeq.current) return
    setSession((current) =>
      // Never step back to an older copy of the same session.
      current && next && current.id === next.id && current.updatedAt > next.updatedAt ? current : next,
    )
  }, [])
  useEffect(() => activeSessionIdSlot.subscribe(() => void showActive().catch(report)), [showActive, report])

  // Background broadcasts.
  useEffect(
    () =>
      onBroadcast((event) => {
        if (!mounted.current) return
        if (event.event === 'queue/updated') setQueue(event.snapshot)
        else if (event.event === 'session/updated') void showActive(event.session).catch(report)
        else if (event.event === 'auth/updated') setAccount(event.account)
        else if (event.event === 'source/updated') setSourceStatus(event.status)
      }),
    [showActive, report],
  )

  // Refresh when the panel regains focus, so a sheet edited elsewhere shows up.
  useEffect(() => {
    if (!preferences.refreshOnFocus) return
    const onFocus = () => void loadQueue(true)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [preferences.refreshOnFocus, loadQueue])

  const visibleJobs = useMemo(() => {
    const jobs = queue?.jobs ?? []
    if (preferences.showCompletedJobs) return jobs
    return jobs.filter((job) => ACTIONABLE_STATUSES.includes(job.status))
  }, [queue, preferences.showCompletedJobs])

  // Switching source changes what the queue even means, so reload it.
  useEffect(() => {
    void loadQueue(true)
  }, [preferences.jobSourceId, loadQueue])

  const saveCsv = useCallback(async (): Promise<SaveResult | null> => {
    const { fileName, text } = await sendMessage('csv/export')
    const result = await saveCsvFile(fileName, text)
    await sendMessage('csv/markSaved', { hasFileHandle: result.hasFileHandle })
    return result
  }, [])

  // Auto-save: only meaningful when we hold a handle that can overwrite the file
  // without prompting. Any failure just leaves the unsaved badge showing.
  const unsaved = sourceStatus?.unsavedChanges ?? 0
  useEffect(() => {
    if (!preferences.autoSaveCsv) return
    if (preferences.jobSourceId !== 'csv') return
    if (unsaved === 0 || !sourceStatus?.canSaveInPlace) return

    let cancelled = false
    void (async () => {
      try {
        const { fileName, text } = await sendMessage('csv/export')
        if (cancelled) return
        const result = await saveCsvFile(fileName, text)
        if (cancelled) return
        // Only a silent in-place write counts as an auto-save.
        if (result.method === 'in-place') {
          await sendMessage('csv/markSaved', { hasFileHandle: true })
        }
      } catch {
        /* the unsaved-changes badge remains, which is the honest outcome */
      }
    })()

    return () => {
      cancelled = true
    }
  }, [unsaved, preferences.autoSaveCsv, preferences.jobSourceId, sourceStatus?.canSaveInPlace])

  const value: AppState = {
    ready,
    account,
    sheetConfig,
    sourceStatus,
    preferences,
    queue,
    session,
    aiStatus,
    visibleJobs,
    loadingQueue,
    busy,
    error,

    connectGoogle: () =>
      run('connect', async () => {
        const acct = await sendMessage('auth/connect')
        setAccount(acct)
        await loadQueue(true)
      }),

    disconnectGoogle: () =>
      run('disconnect', async () => {
        await sendMessage('auth/disconnect')
        setAccount(null)
        setQueue(null)
      }),

    refreshQueue: (force = true) => loadQueue(force),

    openJob: (jobId: string) =>
      run('open', async () => {
        const created = await sendMessage('job/open', { jobId })
        // The page's job info may already have arrived by broadcast; keep the newer copy.
        setSession((current) => (current && current.id === created.id && current.updatedAt > created.updatedAt ? current : created))
      }),

    focusJobTab: () =>
      run('focus', async () => {
        if (!session) return
        await sendMessage('job/focusTab', { sessionId: session.id })
      }),

    markDone: (notes?: string) =>
      run('done', async () => {
        if (!session) return
        await sendMessage('job/markDone', notes ? { sessionId: session.id, notes } : { sessionId: session.id })
        setSession(null)
      }),

    markFailed: (reason: SkipReason, notes?: string) =>
      run('failed', async () => {
        if (!session) return
        await sendMessage('job/markFailed', {
          sessionId: session.id,
          reason,
          ...(notes ? { notes } : {}),
        })
        setSession(null)
      }),

    abandonSession: () =>
      run('abandon', async () => {
        if (!session) return
        await sendMessage('job/abandon', { sessionId: session.id })
        setSession(null)
      }),

    refreshJobInfo: () =>
      run('extract', async () => {
        if (!session) return
        const updated = await sendMessage('session/refreshJobInfo', { sessionId: session.id })
        setSession(updated)
      }),

    // The report is written onto the session by the background worker, which then
    // broadcasts; these actions only need to trigger the pass and surface errors.
    scanPage: () =>
      run('scan', async () => {
        if (!session) return
        await sendMessage('page/scan', { sessionId: session.id })
      }),

    autofillPage: () =>
      run('autofill', async () => {
        if (!session) return
        await sendMessage('page/autofill', { sessionId: session.id })
      }),

    answerField: (input) =>
      run(`answer:${input.fieldId}`, async () => {
        if (!session) return
        await sendMessage('page/answerField', {
          sessionId: session.id,
          fieldId: input.fieldId,
          value: input.value,
          saveAsDefault: input.saveAsDefault,
          label: input.label,
          ...(input.canonicalField ? { canonicalField: input.canonicalField } : {}),
        })
      }),

    highlightField: (fieldId: string) =>
      run('highlight', async () => {
        if (!session) return
        await sendMessage('page/highlightField', { sessionId: session.id, fieldId })
      }),

    perform: run,

    cancelNext: async () => {
      if (!session) return
      await sendMessage('page/cancelNext', { sessionId: session.id }).catch(() => undefined)
    },

    // The outcome lands on the session (lastNavigation) and arrives by broadcast.
    nextPage: (force = false) =>
      run('next', async () => {
        if (!session) return
        await sendMessage('page/next', force ? { sessionId: session.id, force } : { sessionId: session.id })
      }),

    setPreference: async (key, value) => {
      const next = await preferencesSlot.update((current) => ({ ...current, [key]: value }))
      setPreferences(next)
    },

    refreshSourceStatus: async () => {
      await loadSourceStatus()
    },

    refreshAiStatus: loadAiStatus,

    saveCsv: async () => {
      setBusy('saveCsv')
      setError(null)
      try {
        return await saveCsv()
      } catch (err) {
        // Closing the save dialog is a choice, not an error.
        if (!isAbort(err)) report(err)
        return null
      } finally {
        if (mounted.current) setBusy(null)
      }
    },

    dismissError: () => setError(null),
  }

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

export function useAppState(): AppState {
  const state = useContext(AppStateContext)
  if (!state) throw new Error('useAppState must be used inside <AppStateProvider>.')
  return state
}
