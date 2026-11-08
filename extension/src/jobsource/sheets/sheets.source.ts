/**
 * Google Sheets job source.
 *
 * Kept as an optional alternative to the CSV source. It requires a Google Cloud
 * OAuth client ID in the manifest; without one it simply reports itself as not
 * connected rather than failing at an awkward moment.
 */

import { readJobs, updateRow, verifyRow } from '@/google/sheets'
import { currentAccount } from '@/google/auth'
import { missingWritableColumns } from '../row-parser'
import { sheetConfigSlot } from '@/storage/settings'
import { JobSourceNotConfiguredError, type JobSource, type JobSourceReadResult } from '../job-source.interface'
import type { SheetJobPatch } from '@/shared/types/job'
import type { JobSourceId, JobSourceStatus } from '@/shared/types/source'

export class GoogleSheetsJobSource implements JobSource {
  readonly id: JobSourceId = 'google-sheets'
  readonly label = 'Google Sheets'

  async getStatus(): Promise<JobSourceStatus> {
    const [account, config] = await Promise.all([
      currentAccount().catch(() => null),
      sheetConfigSlot.get(),
    ])

    if (!account) {
      return {
        id: this.id,
        label: this.label,
        connected: false,
        detail: 'Not signed in',
        canWriteBack: false,
      }
    }
    if (!config?.spreadsheetId) {
      return {
        id: this.id,
        label: this.label,
        connected: false,
        detail: 'No sheet selected',
        canWriteBack: false,
      }
    }

    return {
      id: this.id,
      label: this.label,
      connected: true,
      detail: config.spreadsheetTitle || config.sheetName,
      canWriteBack: missingWritableColumns(config.columnMap ?? {}).length === 0,
    }
  }

  async readJobs(): Promise<JobSourceReadResult> {
    const config = await this.requireConfig()
    const result = await readJobs(config.spreadsheetId, config.sheetName, config.headerRow)

    // Headers can move between reads; keep the cached map honest.
    await sheetConfigSlot.update((current) =>
      current ? { ...current, columnMap: result.columnMap, detectedHeaders: result.headers } : current,
    )

    return { jobs: result.jobs, headers: result.headers, columnMap: result.columnMap }
  }

  async updateRow(rowNumber: number, patch: SheetJobPatch): Promise<void> {
    const config = await this.requireConfig()
    await updateRow(config.spreadsheetId, config.sheetName, config.columnMap ?? {}, rowNumber, patch)
  }

  async verifyRow(rowNumber: number, expectedJobLink: string): Promise<boolean> {
    const config = await this.requireConfig()
    return verifyRow(
      config.spreadsheetId,
      config.sheetName,
      config.columnMap ?? {},
      rowNumber,
      expectedJobLink,
    )
  }

  private async requireConfig() {
    const config = await sheetConfigSlot.get()
    if (!config?.spreadsheetId) {
      throw new JobSourceNotConfiguredError(
        'No Google Sheet is connected. Open Settings > Job source to connect one.',
      )
    }
    return config
  }
}
