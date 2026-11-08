/** The imported CSV working copy (spec section 4, adapted to a local file source). */

import { defineSlot } from './base'
import type { LocalJobTable } from '@/shared/types/source'

export const jobTableSlot = defineSlot<LocalJobTable | null>('localJobTable', () => null)

export async function requireJobTable(): Promise<LocalJobTable> {
  const table = await jobTableSlot.get()
  if (!table) {
    throw new Error('No CSV is loaded yet. Open Settings > Job source and import your CSV file.')
  }
  return table
}
