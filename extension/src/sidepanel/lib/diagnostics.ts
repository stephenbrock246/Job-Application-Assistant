/**
 * Panel side of the black-box recorder: report a failure the panel saw.
 *
 * The worker owns the records; these only send to it, and never throw - a
 * problem report must not become a second problem.
 */

import { MessageError, sendMessage } from '@/shared/utils/messaging'
import type { IncidentInput } from '@/shared/types/diagnostics'

/** Errors already recorded where they happened, so the generic catch-all skips them. */
const reported = new WeakSet<object>()

export function markReported(error: unknown): void {
  if (error && typeof error === 'object') reported.add(error)
}

export function reportProblem(input: Omit<IncidentInput, 'origin'> & { origin?: string }): Promise<string | null> {
  return sendMessage('diag/report', { ...input, origin: input.origin ?? 'panel' })
    .then((result) => result.incidentId)
    .catch(() => null)
}

/**
 * A failure inside the panel. Errors the worker already returned (MessageError)
 * were recorded there, with the page captured; they are not recorded twice.
 */
export function reportPanelError(error: unknown, origin: string, sessionId?: string): void {
  if (error instanceof MessageError) return
  if (error && typeof error === 'object' && reported.has(error)) return
  markReported(error)
  void reportProblem({
    kind: 'panel-error',
    message: error instanceof Error ? error.message : String(error),
    origin,
    capture: false,
    ...(sessionId ? { sessionId } : {}),
    ...(error instanceof Error && error.stack ? { data: { stack: error.stack } } : {}),
  })
}

export function installPanelCrashHandlers(): void {
  window.addEventListener('error', (event) => reportPanelError(event.error ?? event.message, 'panel:crash'))
  window.addEventListener('unhandledrejection', (event) => reportPanelError(event.reason, 'panel:crash'))
}
