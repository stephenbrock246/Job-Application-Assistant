/**
 * Runs AI writing tasks (resume, cover letter, answers) the same way whatever the
 * provider:
 *
 *   compose prompt -> direct provider: call it and finish now
 *                  -> handoff provider: copy the prompt, park it on the session,
 *                     finish when the user pastes the reply (even after a restart)
 */

import { useCallback } from 'react'
import { useAppState } from '../state/AppStateContext'
import { AICancelledError, getProviderFor } from '@/ai'
import { throwIfCancelled } from '@/ai/retry'
import { sendMessage } from '@/shared/utils/messaging'
import { copyText } from '../lib/handoff'
import { markReported, reportProblem } from '../lib/diagnostics'
import { runExclusive, taskKey, trackEvents, TaskBusyError } from '../lib/ai-activity'
import type { GeneratedBy, PendingAITask } from '@/shared/types/ai'
import type { WritingPatch } from '@/shared/types/messages'

export type FinishTask = (
  task: PendingAITask,
  reply: string,
  meta?: {
    generatedBy?: GeneratedBy
    /** Cancel for any further network step (the HumanGPT rewrite). */
    signal?: AbortSignal
    /** Progress text for the running task. */
    report?: (message: string) => void
  },
) => Promise<WritingPatch>

/** An autopilot step marked running this recently is live (possibly in another panel). */
const LIVE_RUNNING_MS = 4 * 60_000

export function useWriting() {
  const { session } = useAppState()
  const sessionId = session?.id

  const update = useCallback(
    async (patch: WritingPatch) => {
      if (!sessionId) throw new Error('No application is open.')
      await sendMessage('session/updateWriting', { sessionId, patch })
    },
    [sessionId],
  )

  /**
   * Starts a task. Resolves once the result is stored, or once the prompt is handed off.
   * A direct call holds the task's exclusive lock for its whole life, retries included.
   */
  const start = useCallback(
    async (key: string, compose: () => Promise<PendingAITask>, finish: FinishTask) => {
      if (!sessionId) throw new Error('No application is open.')
      const provider = await getProviderFor(key)

      if (provider.mode === 'direct') {
        if (!provider.complete) throw new Error(`${provider.label} cannot be used directly.`)
        // Autopilot in another panel may own this step; its "running" mark is on the session.
        const step = key === 'resume' || key === 'coverLetter' ? session?.autopilot?.[key] : undefined
        if (step?.state === 'running' && Date.now() - step.at < LIVE_RUNNING_MS) throw new TaskBusyError()

        const label = provider.label.replace(/\s*API$/, '')
        try {
          await runExclusive(taskKey(sessionId, key), `Waiting for ${label}...`, async (report, signal) => {
            const task = await compose()
            const events = trackEvents(report, label)
            const reply = await provider.complete!(task.prompt, { onEvent: events.onEvent, signal })
            // Cancel pressed just as the reply arrived: honour it - nothing is saved.
            throwIfCancelled(signal)
            const generatedBy = events.generatedBy()
            const patch = await finish(task, reply, { ...(generatedBy ? { generatedBy } : {}), signal, report })
            throwIfCancelled(signal)
            await update({ ...patch, pendingAi: { [key]: null } })
          })
        } catch (error) {
          // Cancelling is a choice, not an error: leave everything as it was, say nothing.
          if (error instanceof AICancelledError) return
          // The chat tab is talked to from here, not through the worker, so record it here.
          if (!(error instanceof TaskBusyError)) {
            markReported(error)
            void reportProblem({
              kind: 'ai-failed',
              message: error instanceof Error ? error.message : String(error),
              origin: `ai:${key} (${provider.label})`,
              sessionId,
              capture: false,
            })
          }
          throw error
        }
        return
      }

      const task = await compose()
      // Copying can fail if the panel lost focus; the handoff card has a Copy button.
      await copyText(task.prompt).catch(() => undefined)
      await update({ pendingAi: { [key]: task } })
    },
    [sessionId, session, update],
  )

  /** Applies a pasted reply. Throws (with a user-facing message) if it cannot be used. */
  const complete = useCallback(
    async (key: string, reply: string, finish: FinishTask) => {
      const task = session?.pendingAi?.[key]
      if (!task) throw new Error('That prompt is no longer waiting for a reply.')
      await update({ ...(await finish(task, reply)), pendingAi: { [key]: null } })
    },
    [session, update],
  )

  const cancel = useCallback((key: string) => update({ pendingAi: { [key]: null } }), [update])

  return { update, start, complete, cancel, pending: session?.pendingAi ?? {} }
}
