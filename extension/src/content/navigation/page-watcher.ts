/**
 * Page-change detection (spec section 17).
 *
 * Two jobs, one mechanism - a MutationObserver plus a settle rule:
 *
 *  - `awaitChange` answers "did clicking Next move us anywhere?" for the navigation
 *    loop, with a deadline.
 *  - The passive watcher notices the user moving through the form by hand, so the
 *    panel follows along without a manual rescan.
 *
 * URL changes are not relied on: plenty of application flows are single-page apps
 * that swap the form in place. The fingerprint (see page-state.ts) is the judge.
 */

import { capturePage, isLoading } from './page-state'
import { detectValidationErrors } from '../validation/validators'
import { comparePages } from '@/shared/utils/page-compare'
import type { PageChange, PageFingerprint, ValidationError } from '@/shared/types/application'

/** Attribute changes that show or hide content; anything else is cosmetic churn. */
const VISIBILITY_ATTRIBUTES = ['hidden', 'style', 'class', 'aria-hidden', 'disabled', 'open']

function observe(target: Node, callback: () => void): MutationObserver {
  const observer = new MutationObserver(callback)
  observer.observe(target, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: VISIBILITY_ATTRIBUTES,
  })
  return observer
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Resolves once the DOM has been quiet for `quietMs` and no loading indicator is
 * visible - or when `maxMs` runs out, whichever is first. A page that animates
 * forever therefore costs a timeout, never a hang.
 */
export function waitForQuiet(quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let finished = false

    const finish = () => {
      if (finished) return
      finished = true
      observer.disconnect()
      clearTimeout(quietTimer)
      clearTimeout(capTimer)
      resolve()
    }

    const arm = () => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(() => (isLoading() ? arm() : finish()), quietMs)
    }

    const observer = observe(document.documentElement, arm)
    const capTimer = setTimeout(finish, Math.max(0, maxMs))
    arm()
  })
}

export interface ChangeResult {
  page: PageFingerprint
  change: PageChange
  errors: ValidationError[]
  timedOut: boolean
  cancelled?: boolean
}

/** Ends the current awaitChange early (the user pressed Cancel in the panel). */
let cancelCurrentWait: (() => void) | null = null

export function cancelWait(): void {
  cancelCurrentWait?.()
}

/**
 * Waits for the page to move away from `baseline`.
 *
 * Returns early on a real change, or - once the site has had a moment to react -
 * on visible validation errors, since a page that is showing errors is not going
 * anywhere. Otherwise it waits out the deadline and reports `timedOut`.
 */
export async function awaitChange(baseline: PageFingerprint, timeoutMs: number): Promise<ChangeResult> {
  const started = Date.now()
  const deadline = started + timeoutMs
  /** Async validation and slow submits both need a beat before errors mean "refused". */
  const errorGraceMs = 1_500

  let cancelled = false
  const cancelSignal = new Promise<void>((resolve) => {
    cancelCurrentWait = () => {
      cancelled = true
      resolve()
    }
  })
  const orCancel = (wait: Promise<void>) => Promise.race([wait, cancelSignal])
  const stop = (): ChangeResult => ({
    page: capturePage(),
    change: 'same',
    errors: [],
    timedOut: false,
    cancelled: true,
  })

  pauseWatching()
  try {
    await orCancel(sleep(250))
    if (cancelled) return stop()

    for (;;) {
      await orCancel(waitForQuiet(500, deadline - Date.now()))
      if (cancelled) return stop()

      const page = capturePage()
      const change = comparePages(baseline, page)
      if (change !== 'same') {
        return { page, change, errors: detectValidationErrors(), timedOut: false }
      }

      const errors = detectValidationErrors()
      if (errors.length && Date.now() - started >= errorGraceMs) {
        return { page, change, errors, timedOut: false }
      }

      if (Date.now() >= deadline) return { page, change, errors, timedOut: true }
      await orCancel(sleep(250))
      if (cancelled) return stop()
    }
  } finally {
    cancelCurrentWait = null
    resumeWatching()
  }
}

// ---------------------------------------------------------------------------
// Passive watcher
// ---------------------------------------------------------------------------

export type ChangeListener = (change: Exclude<PageChange, 'same'>, page: PageFingerprint) => void

interface WatchState {
  baseline: PageFingerprint
  observer: MutationObserver
  listener: ChangeListener
  debounce?: ReturnType<typeof setTimeout>
  /** When the first unevaluated mutation arrived, so constant churn still gets checked. */
  pendingSince?: number
  paused: boolean
}

let watch: WatchState | null = null

const DEBOUNCE_MS = 700
const MAX_DEFER_MS = 3_000

export function startWatching(listener: ChangeListener): void {
  stopWatching()

  const state: WatchState = {
    baseline: capturePage(),
    observer: observe(document.documentElement, () => schedule()),
    listener,
    paused: false,
  }
  watch = state
  window.addEventListener('popstate', schedule)
  window.addEventListener('hashchange', schedule)
}

export function stopWatching(): void {
  if (!watch) return
  watch.observer.disconnect()
  clearTimeout(watch.debounce)
  window.removeEventListener('popstate', schedule)
  window.removeEventListener('hashchange', schedule)
  watch = null
}

export function isWatching(): boolean {
  return watch !== null
}

/**
 * Tells the watcher what the page looks like now. Called after every scan, so a
 * change the background already knows about is not reported back to it.
 */
export function setBaseline(page: PageFingerprint): void {
  if (watch) watch.baseline = page
}

function pauseWatching(): void {
  if (watch) watch.paused = true
}

function resumeWatching(): void {
  if (!watch) return
  watch.paused = false
  // Whatever happened while paused was reported by awaitChange; start clean.
  watch.baseline = capturePage()
  watch.pendingSince = undefined
  clearTimeout(watch.debounce)
}

function schedule(): void {
  const state = watch
  if (!state || state.paused) return

  const now = Date.now()
  state.pendingSince ??= now
  clearTimeout(state.debounce)

  const overdue = now - state.pendingSince >= MAX_DEFER_MS
  state.debounce = setTimeout(evaluate, overdue ? 0 : DEBOUNCE_MS)
}

function evaluate(): void {
  const state = watch
  if (!state || state.paused) return
  if (isLoading()) {
    state.debounce = setTimeout(evaluate, DEBOUNCE_MS)
    return
  }

  state.pendingSince = undefined
  const page = capturePage()
  const change = comparePages(state.baseline, page)
  if (change === 'same') return

  state.baseline = page
  state.listener(change, page)
}
