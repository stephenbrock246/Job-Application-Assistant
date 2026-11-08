/**
 * Fills empty profile fields from the master resume - once per uploaded resume
 * (and once more whenever the reader improves), never replacing a value. A field
 * the user clears afterwards stays cleared.
 */

import { useEffect } from 'react'
import { useStorageSlot } from './useStorageSlot'
import { defineSlot } from '@/storage/base'
import { masterResumeSlot } from '@/storage/settings'
import { profileSlot } from '@/storage/applicant-profile'
import { masterParagraphs } from '@/resume/resume-parser'
import { extractProfile, mergeSuggestions } from '@/resume/profile-extract'
import type { MasterResumeMeta } from '@/shared/types/settings'

/** Bump when profile-extract.ts reads more, so existing resumes are read again. */
const READER_VERSION = 2
const filledFromSlot = defineSlot<string>('profileFilledFrom', () => '')

export function useProfileFromResume(): void {
  const [master] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)

  useEffect(() => {
    if (!master) return
    const mark = `${master.uploadedAt}:v${READER_VERSION}`
    void (async () => {
      if ((await filledFromSlot.get()) === mark) return
      const { profile, applied } = mergeSuggestions(await profileSlot.get(), extractProfile(masterParagraphs(master)), true)
      if (applied.length) await profileSlot.set({ ...profile, updatedAt: Date.now() })
      await filledFromSlot.set(mark)
    })().catch(() => undefined)
  }, [master?.uploadedAt])
}
