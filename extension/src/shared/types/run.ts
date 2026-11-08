/**
 * Unattended run: the extension works through the job list by itself in one
 * Chrome window, and stops before every final submit for the user's approval.
 *
 * Per job (keyed by its link):
 *   working    -> being filled now
 *   ready      -> every page filled, safety check passed; waiting for "Submit"
 *   submitting -> the user approved; submitting now
 *   submitted  -> sent, and the site confirmed it; recorded as Applied
 *   check      -> sent, but no confirmation was seen; the user checks the tab
 *   needs-help -> paused on something only the user can do; its tab stays open
 *   skipped    -> not attempted (a site whose terms forbid automation)
 */

export type RunItemState = 'working' | 'ready' | 'submitting' | 'submitted' | 'check' | 'needs-help' | 'skipped'

export interface RunItem {
  /** jobUrlKey of the job's link. */
  key: string
  jobLink: string
  company: string
  position: string
  sessionId?: string
  state: RunItemState
  /** One sentence: why it needs help, or what happened. */
  reason?: string
  /** Safety check findings: blocking ones for needs-help, things worth a look for ready. */
  problems?: string[]
  /** The user fixed what it needed and pressed Continue: the runner finishes it next, on its open tab. */
  retry?: boolean
  at: number
}

export type RunMode = 'idle' | 'running'

export interface RunState {
  mode: RunMode
  /** The window the run works in (the second monitor's). Job and chat tabs open there. */
  windowId?: number
  startedAt?: number
  /** Last sign of life from the runner. A stale one means the panel was closed mid-run. */
  heartbeatAt?: number
  /** What it is doing right now, for the panel. */
  status: string
  currentKey?: string
  items: Record<string, RunItem>
}

/**
 * Jobs waiting for the user (ready to approve, or needing help) before the runner
 * stops starting new ones. 1: strictly one job at a time - the next starts only
 * after the user has submitted, continued or skipped the current one.
 */
export const MAX_WAITING = 1
