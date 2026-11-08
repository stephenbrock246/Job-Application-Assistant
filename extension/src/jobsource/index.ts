/**
 * Job source registry - the only module the background worker imports from here.
 */

import { CsvJobSource } from './csv/csv.source'
import { GoogleSheetsJobSource } from './sheets/sheets.source'
import { SheetLinkJobSource } from './sheet-link/sheet-link.source'
import { preferencesSlot } from '@/storage/settings'
import type { JobSource } from './job-source.interface'
import type { JobSourceId } from '@/shared/types/source'

const sources: Record<JobSourceId, () => JobSource> = {
  csv: () => new CsvJobSource(),
  'google-sheets': () => new GoogleSheetsJobSource(),
  'sheet-link': () => new SheetLinkJobSource(),
}

export const JOB_SOURCE_OPTIONS: { id: JobSourceId; label: string; note: string }[] = [
  {
    id: 'sheet-link',
    label: 'Google Sheet (paste link)',
    note: 'Reads your sheet live from its link. No Google Cloud, no sign-in. You update statuses in the sheet yourself.',
  },
  {
    id: 'csv',
    label: 'CSV file',
    note: 'Import a .csv and save it back. No accounts, no setup.',
  },
]

export function getSource(id: JobSourceId): JobSource {
  return (sources[id] ?? sources.csv)()
}

export async function getActiveSource(): Promise<JobSource> {
  const prefs = await preferencesSlot.get()
  return getSource(prefs.jobSourceId)
}

export type { JobSource } from './job-source.interface'
