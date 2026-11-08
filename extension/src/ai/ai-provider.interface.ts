/**
 * The AI boundary.
 *
 * Re-exported here so that application code imports from `@/ai` and never from a
 * concrete provider module. If you find yourself importing `claude.provider` from
 * outside this folder, the abstraction has leaked.
 */

export type {
  AIProvider,
  AIProviderId,
  AIProviderStatus,
  AITransportMode,
  AITaskKind,
  PendingAITask,
  ApplicationQuestionRequest,
} from '@/shared/types/ai'

export { AICancelledError } from './retry'

/** A model reply that could not be used. The message is shown to the user verbatim. */
export class AIReplyError extends Error {
  code = 'AI_BAD_REPLY'
  constructor(message: string) {
    super(message)
    this.name = 'AIReplyError'
  }
}
