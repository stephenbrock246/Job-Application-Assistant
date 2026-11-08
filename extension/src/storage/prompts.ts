/**
 * Prompt profiles (spec sections 11 and 12, cover letter addendum).
 *
 * Two kinds - resume tailoring and cover letter - each with its own list and its
 * own single default. One-off "for this job" instructions never touch these.
 */

import { defineSlot } from './base'
import {
  STORAGE_KEYS,
  createDefaultCoverLetterProfile,
  createDefaultPromptProfile,
} from '@/shared/constants/defaults'
import { createId } from '@/shared/utils/format'
import type { PromptKind, PromptProfile } from '@/shared/types/settings'

const DEFAULT_FOR: Record<PromptKind, () => PromptProfile> = {
  resume: createDefaultPromptProfile,
  coverLetter: createDefaultCoverLetterProfile,
}

/**
 * Profiles saved before cover letters existed have no kind - they are resume
 * prompts. A kind with no profiles at all gets its default.
 */
function normalise(stored: PromptProfile[]): PromptProfile[] {
  const profiles: PromptProfile[] = stored.map((p) => ({ ...p, kind: p.kind ?? 'resume' }))
  for (const kind of Object.keys(DEFAULT_FOR) as PromptKind[]) {
    if (!profiles.some((p) => p.kind === kind)) profiles.push(DEFAULT_FOR[kind]())
  }
  return profiles
}

export const promptsSlot = defineSlot<PromptProfile[]>(
  STORAGE_KEYS.prompts,
  () => [createDefaultPromptProfile(), createDefaultCoverLetterProfile()],
  normalise,
)

export function kindOf(profile: PromptProfile): PromptKind {
  return profile.kind ?? 'resume'
}

export async function listPrompts(kind: PromptKind): Promise<PromptProfile[]> {
  const prompts = (await promptsSlot.get()).filter((p) => kindOf(p) === kind)
  return prompts.length ? prompts : [DEFAULT_FOR[kind]()]
}

export async function getDefaultPrompt(kind: PromptKind): Promise<PromptProfile> {
  const prompts = await listPrompts(kind)
  return prompts.find((p) => p.isDefault) ?? prompts[0]!
}

export async function savePrompt(profile: PromptProfile): Promise<void> {
  await promptsSlot.update((current) => {
    const next = current.some((p) => p.id === profile.id)
      ? current.map((p) => (p.id === profile.id ? { ...profile, updatedAt: Date.now() } : p))
      : [...current, { ...profile, updatedAt: Date.now() }]
    return ensureSingleDefault(next, kindOf(profile), profile.isDefault ? profile.id : undefined)
  })
}

export async function createPrompt(kind: PromptKind, name: string, prompt: string): Promise<PromptProfile> {
  const profile: PromptProfile = {
    id: createId('prompt'),
    kind,
    name,
    prompt,
    isDefault: false,
    updatedAt: Date.now(),
  }
  await promptsSlot.update((current) => [...current, profile])
  return profile
}

export async function duplicatePrompt(id: string): Promise<PromptProfile | null> {
  const source = (await promptsSlot.get()).find((p) => p.id === id)
  if (!source) return null
  return createPrompt(kindOf(source), `${source.name} (copy)`, source.prompt)
}

export async function setDefaultPrompt(id: string): Promise<void> {
  await promptsSlot.update((current) => {
    const target = current.find((p) => p.id === id)
    return target ? ensureSingleDefault(current, kindOf(target), id) : current
  })
}

export async function deletePrompt(id: string): Promise<void> {
  await promptsSlot.update((current) => {
    const target = current.find((p) => p.id === id)
    if (!target) return current
    const kind = kindOf(target)
    // Never leave a kind with zero profiles.
    if (current.filter((p) => kindOf(p) === kind).length <= 1) return current
    return ensureSingleDefault(
      current.filter((p) => p.id !== id),
      kind,
    )
  })
}

/** Exactly one default per kind; other kinds are left untouched. */
function ensureSingleDefault(profiles: PromptProfile[], kind: PromptKind, defaultId?: string): PromptProfile[] {
  const ofKind = profiles.filter((p) => kindOf(p) === kind)
  if (!ofKind.length) return [...profiles, DEFAULT_FOR[kind]()]
  const targetId = defaultId ?? ofKind.find((p) => p.isDefault)?.id ?? ofKind[0]!.id
  return profiles.map((p) => (kindOf(p) === kind ? { ...p, isDefault: p.id === targetId } : p))
}
