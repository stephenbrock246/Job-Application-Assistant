import { defineSlot } from './base'
import { EMPTY_PROFILE, STORAGE_KEYS } from '@/shared/constants/defaults'
import { CANONICAL_FIELD_BY_KEY } from '@/shared/constants/canonical-fields'
import type { ApplicantProfile } from '@/shared/types/profile'

// Profiles saved before a section existed (e.g. `voluntary`) get it empty, never undefined.
export const profileSlot = defineSlot<ApplicantProfile>(
  STORAGE_KEYS.profile,
  () => ({ ...EMPTY_PROFILE }),
  (stored) => ({
    ...EMPTY_PROFILE,
    ...stored,
    personal: { ...EMPTY_PROFILE.personal, ...stored.personal },
    professional: { ...EMPTY_PROFILE.professional, ...stored.professional },
    preferences: { ...EMPTY_PROFILE.preferences, ...stored.preferences },
    workAuthorization: { ...EMPTY_PROFILE.workAuthorization, ...stored.workAuthorization },
    voluntary: { ...EMPTY_PROFILE.voluntary, ...(stored.voluntary ?? {}) },
  }),
)

/** The applicant's name for file names ("Agamyrat Akmyradov"), or "" when the profile has none. */
export async function fileOwnerName(): Promise<string> {
  const { fullName, firstName, lastName } = (await profileSlot.get()).personal
  return fullName.trim() || [firstName, lastName].map((part) => part.trim()).filter(Boolean).join(' ')
}

export async function saveProfile(profile: ApplicantProfile): Promise<void> {
  await profileSlot.set({ ...profile, updatedAt: Date.now() })
}

/**
 * Reads a canonical field's value from the profile.
 * Returns an empty string when unknown - callers must treat that as "ask the user",
 * never as "fill with a guess".
 */
export function readCanonicalValue(profile: ApplicantProfile, key: string): string {
  const def = CANONICAL_FIELD_BY_KEY.get(key)
  if (!def?.read) return ''
  return def.read(profile).trim()
}

/** How complete the profile is, used for the settings progress hint. */
export function profileCompleteness(profile: ApplicantProfile): { filled: number; total: number } {
  const groups = [profile.personal, profile.professional, profile.preferences, profile.workAuthorization]
  let filled = 0
  let total = 0
  for (const group of groups) {
    for (const value of Object.values(group)) {
      if (typeof value !== 'string') continue
      total += 1
      if (value.trim()) filled += 1
    }
  }
  return { filled, total }
}
