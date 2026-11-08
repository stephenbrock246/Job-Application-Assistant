/** Preferences, sheet configuration, master resume metadata and Google account info. */

import { defineSlot } from './base'
import { DEFAULT_PREFERENCES, STORAGE_KEYS } from '@/shared/constants/defaults'
import type { SheetConfig } from '@/shared/types/sheet'
import type { GoogleAccountInfo, MasterResumeMeta, Preferences } from '@/shared/types/settings'
import type { QueueSnapshot } from '@/shared/types/messages'

// Stored preferences are merged over the defaults, so a preference added in a later
// version reads as its default rather than `undefined` for existing installs.
export const preferencesSlot = defineSlot<Preferences>(
  STORAGE_KEYS.preferences,
  () => ({ ...DEFAULT_PREFERENCES }),
  (stored) => withoutRetiredOptions({ ...DEFAULT_PREFERENCES, ...stored }),
)

/**
 * Options that were removed from the product read as their replacement: the
 * copy/paste providers and the unavailable Claude API become Gemini, the sign-in
 * Google Sheets source becomes the sheet link, and the humanizer is off.
 */
function withoutRetiredOptions(prefs: Preferences): Preferences {
  const providers: Preferences['aiProviderId'][] = ['gemini-api', 'openai-api']
  return {
    ...prefs,
    aiProviderId: providers.includes(prefs.aiProviderId) ? prefs.aiProviderId : 'gemini-api',
    jobSourceId: prefs.jobSourceId === 'google-sheets' ? 'sheet-link' : prefs.jobSourceId,
    humanizerEnabled: false,
  }
}

export const sheetConfigSlot = defineSlot<SheetConfig | null>(STORAGE_KEYS.sheetConfig, () => null)

export const masterResumeSlot = defineSlot<MasterResumeMeta | null>(
  STORAGE_KEYS.masterResume,
  () => null,
)

export const googleAccountSlot = defineSlot<GoogleAccountInfo | null>(
  STORAGE_KEYS.googleAccount,
  () => null,
)

export const queueCacheSlot = defineSlot<QueueSnapshot | null>(STORAGE_KEYS.queueCache, () => null)

export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  return preferencesSlot.update((current) => ({ ...current, ...patch }))
}

export async function requireSheetConfig(): Promise<SheetConfig> {
  const config = await sheetConfigSlot.get()
  if (!config?.spreadsheetId) {
    throw new Error('No Google Sheet is connected yet. Open Settings > Google Sheet to connect one.')
  }
  return config
}
