/**
 * Application sessions (spec section 19).
 *
 * Sessions are keyed by id and persisted so that closing Chrome mid-application
 * does not lose where the user was. `activeSessionId` is what the side panel's
 * "Current Application" card renders.
 */

import { defineSlot } from './base'
import { STORAGE_KEYS } from '@/shared/constants/defaults'
import { sameJobUrl } from '@/shared/utils/job-url'
import type { ApplicationSession } from '@/shared/types/application'

type SessionMap = Record<string, ApplicationSession>

export const sessionsSlot = defineSlot<SessionMap>(STORAGE_KEYS.sessions, () => ({}))
export const activeSessionIdSlot = defineSlot<string | null>(STORAGE_KEYS.activeSessionId, () => null)

export async function getSession(id: string): Promise<ApplicationSession | null> {
  const sessions = await sessionsSlot.get()
  return sessions[id] ?? null
}

export async function getActiveSession(): Promise<ApplicationSession | null> {
  const id = await activeSessionIdSlot.get()
  if (!id) return null
  return getSession(id)
}

/**
 * Every write to the sessions map goes through this queue, and each one reads the
 * map inside it. The worker handles many messages at once (a page pass, a tab
 * event, a tailoring update); without the queue two writes both started from the
 * same map and the later one silently dropped the other's change - a lost resume,
 * report or tab - or brought back a session that had just been removed.
 */
let writes: Promise<unknown> = Promise.resolve()

function queued<T>(write: () => Promise<T>): Promise<T> {
  const next = writes.then(write, write)
  writes = next.catch(() => undefined)
  return next
}

export function saveSession(session: ApplicationSession): Promise<ApplicationSession> {
  return queued(async () => {
    const next = { ...session, updatedAt: Date.now() }
    await sessionsSlot.update((current) => ({ ...current, [next.id]: next }))
    return next
  })
}

/** Merges `patch` into the session as it is stored at the moment of writing. Null when it no longer exists. */
export function patchSession(id: string, patch: Partial<ApplicationSession>): Promise<ApplicationSession | null> {
  return queued(async () => {
    let saved: ApplicationSession | null = null
    await sessionsSlot.update((current) => {
      const existing = current[id]
      if (!existing) return current
      saved = { ...existing, ...patch, updatedAt: Date.now() }
      return { ...current, [id]: saved }
    })
    return saved
  })
}

export async function setActiveSession(id: string | null): Promise<void> {
  await activeSessionIdSlot.set(id)
}

export function removeSession(id: string): Promise<void> {
  return queued(async () => {
    await sessionsSlot.update((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    const activeId = await activeSessionIdSlot.get()
    if (activeId === id) await activeSessionIdSlot.set(null)
  })
}

/**
 * Finds the in-flight session for a job, so re-opening it resumes where it was.
 *
 * Matched by the job's link, not its row: rows move when a list is edited or a
 * longer file is imported under the same name, and a row number alone would hand
 * one job another job's tailored resume. A session found under a different row is
 * the same job that moved; the caller updates its row.
 */
export async function findSessionForJob(
  spreadsheetId: string,
  sheetName: string,
  jobLink: string,
): Promise<ApplicationSession | null> {
  const sessions = await sessionsSlot.get()
  return (
    Object.values(sessions)
      .filter(
        (s) =>
          s.spreadsheetId === spreadsheetId &&
          s.sheetName === sheetName &&
          s.status !== 'SUBMITTED' &&
          sameJobUrl(s.jobUrl, jobLink),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  )
}

/** The session a tab is working on, if any. */
export async function findSessionForTab(tabId: number): Promise<ApplicationSession | null> {
  const sessions = await sessionsSlot.get()
  return Object.values(sessions).find((s) => s.tabId === tabId) ?? null
}

export async function listSessions(): Promise<ApplicationSession[]> {
  const sessions = await sessionsSlot.get()
  return Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt)
}
