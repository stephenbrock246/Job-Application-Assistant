/**
 * Resume tailoring orchestration (spec sections 10-12).
 *
 * master resume paragraphs + prompt profile + one-off instructions + job description
 *   -> prompt (any provider)
 *   -> reply -> validated paragraph edits + fabrication warnings
 *
 * Split into compose/finish because with copy/paste the reply can arrive minutes -
 * or a panel restart - later. Everything `finish` needs is either in storage or
 * recorded on the pending task.
 */

import { buildTailorPrompt, parseTailorReply } from '@/ai/prompts'
import { AIReplyError } from '@/ai'
import { checkFacts } from './fact-check'
import { masterParagraphs } from './resume-parser'
import { getDefaultPrompt, listPrompts } from '@/storage/prompts'
import { masterResumeSlot } from '@/storage/settings'
import type { ApplicationSession } from '@/shared/types/application'
import type { PendingAITask } from '@/shared/types/ai'
import type { TailoredResumeState } from '@/shared/types/resume'
import type { MasterResumeMeta, PromptProfile } from '@/shared/types/settings'

export async function requireMaster(): Promise<MasterResumeMeta> {
  const master = await masterResumeSlot.get()
  if (!master || (!master.text.trim() && !master.docxBase64)) {
    throw new Error('No master resume yet. Add one in Settings > Resume first.')
  }
  return master
}

export function requireJobDescription(session: ApplicationSession): string {
  const description = session.jobInfo?.description.trim() ?? ''
  if (!description) {
    throw new Error('No job description has been extracted yet. Open the job posting and press "Scan page" under Job description.')
  }
  return description
}

async function resolveProfile(profileId: string | undefined): Promise<PromptProfile> {
  const profiles = await listPrompts('resume')
  return profiles.find((p) => p.id === profileId) ?? (await getDefaultPrompt('resume'))
}

/** Builds the prompt and the pending-task record that will receive the reply. */
export async function composeTailoring(
  session: ApplicationSession,
  options: { promptProfileId?: string; instructions?: string },
): Promise<PendingAITask> {
  const master = await requireMaster()
  const profile = await resolveProfile(options.promptProfileId)
  const instructions = options.instructions?.trim()

  return {
    kind: 'resume',
    prompt: buildTailorPrompt({
      paragraphs: masterParagraphs(master),
      tailoringPrompt: profile.prompt,
      ...(instructions ? { additionalInstructions: instructions } : {}),
      jobDescription: requireJobDescription(session),
      company: session.company,
      position: session.position,
    }),
    createdAt: Date.now(),
    promptProfileId: profile.id,
    ...(instructions ? { instructions } : {}),
    masterUploadedAt: master.uploadedAt,
  }
}

export interface TailoringResult {
  state: TailoredResumeState
  /** Parts of the reply that were dropped, and why. */
  ignored: string[]
}

export async function finishTailoring(
  session: ApplicationSession,
  task: PendingAITask,
  reply: string,
): Promise<TailoringResult> {
  const master = await requireMaster()
  if (task.masterUploadedAt !== undefined && task.masterUploadedAt !== master.uploadedAt) {
    throw new AIReplyError('Your master resume changed after this prompt was made. Generate the prompt again.')
  }

  const paragraphs = masterParagraphs(master)
  const parsed = parseTailorReply(reply, paragraphs)
  if (!parsed.edits.length) {
    throw new AIReplyError('The reply changes nothing. Paste the complete reply, or regenerate with different instructions.')
  }

  const profile = await resolveProfile(task.promptProfileId)
  const context = {
    source: master.text,
    jobDescription: session.jobInfo?.description ?? '',
  }

  return {
    state: {
      promptProfileId: profile.id,
      promptProfileName: profile.name,
      ...(task.instructions ? { instructions: task.instructions } : {}),
      edits: parsed.edits,
      changeNotes: parsed.notes,
      warnings: parsed.edits.flatMap((edit) =>
        edit.removed ? [] : checkFacts(edit.text, context, edit.id),
      ),
      masterFileName: master.fileName,
      masterUploadedAt: master.uploadedAt,
      generatedAt: Date.now(),
      approved: false,
    },
    ignored: parsed.ignored,
  }
}

/** Re-runs the fact check after the user edits a paragraph in review. */
export function recheckEdits(
  state: TailoredResumeState,
  master: MasterResumeMeta,
  jobDescription: string,
): TailoredResumeState {
  const context = { source: master.text, jobDescription }
  return {
    ...state,
    warnings: state.edits.flatMap((edit) => (edit.removed ? [] : checkFacts(edit.text, context, edit.id))),
  }
}
