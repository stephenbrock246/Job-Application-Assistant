/**
 * In-flight AI tasks: an exclusive lock plus live progress text.
 *
 * One logical operation - "tailor the resume for this application" - holds its key
 * (`<sessionId>:resume`) from the first request until its result is stored. The
 * manual button and autopilot both go through `runExclusive`, so they can never
 * run the same operation twice at once; retries happen inside that one hold and so
 * can never produce a second result, file or upload.
 *
 * Progress text ("Gemini is busy - retrying (2/5)...") is published per key for
 * any component that wants to show it.
 */

import { useSyncExternalStore } from 'react'
import type { AIEvent, GeneratedBy } from '@/shared/types/ai'

interface Running {
  message: string
  controller: AbortController
}

const running = new Map<string, Running>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export class TaskBusyError extends Error {
  constructor() {
    super('This is already running. Wait for it to finish.')
    this.name = 'TaskBusyError'
  }
}

export function taskKey(sessionId: string, task: string): string {
  return `${sessionId}:${task}`
}

export function isRunning(key: string): boolean {
  return running.has(key)
}

/**
 * Runs `work` holding `key`. Throws TaskBusyError if the key is already held.
 * `report` updates the progress text shown for the key; `signal` fires when the
 * user presses Cancel and must be passed to anything slow (requests, waits).
 */
export async function runExclusive<T>(
  key: string,
  initial: string,
  work: (report: (message: string) => void, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (running.has(key)) throw new TaskBusyError()
  const controller = new AbortController()
  running.set(key, { message: initial, controller })
  emit()
  try {
    return await work((message) => {
      const entry = running.get(key)
      // After Cancel, late progress from the dying request is not shown.
      if (!entry || entry.controller !== controller || controller.signal.aborted) return
      running.set(key, { ...entry, message })
      emit()
    }, controller.signal)
  } finally {
    if (running.get(key)?.controller === controller) running.delete(key)
    emit()
  }
}

/**
 * Stops the task holding `key`: aborts its request and any retry wait. The task's
 * own code sees AICancelledError and leaves everything as it was.
 */
export function cancelTask(key: string): void {
  const entry = running.get(key)
  if (!entry || entry.controller.signal.aborted) return
  entry.controller.abort()
  running.set(key, { ...entry, message: 'Cancelling...' })
  emit()
}

/** Live progress text for a key, or undefined when nothing is running. */
export function useActivity(key: string | null): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (key ? running.get(key)?.message : undefined),
  )
}

/** Turns provider events into progress text, and records which model answered. */
export function trackEvents(report: (message: string) => void, providerLabel: string) {
  let generatedBy: GeneratedBy | undefined
  const onEvent = (event: AIEvent) => {
    if (event.type === 'retry') {
      const seconds = Math.max(1, Math.round(event.delayMs / 1000))
      const why = event.status === 429 ? 'rate limited' : event.status === 0 ? 'connection failed' : 'busy'
      report(`${providerLabel} is ${why} - retrying (${event.attempt}/${event.maxRetries}) in ${seconds}s...`)
    } else if (event.type === 'fallback') {
      report(`${event.from} is still overloaded - trying fallback model ${event.to}...`)
    } else {
      generatedBy = { model: event.model, fallback: event.fallback }
    }
  }
  return { onEvent, generatedBy: () => generatedBy }
}

/** "via gemini-2.5-flash (fallback)" - for result lines. */
export function describeGeneratedBy(generatedBy: GeneratedBy | undefined): string {
  if (!generatedBy) return ''
  return `via ${generatedBy.model}${generatedBy.fallback ? ' (fallback model)' : ''}`
}
