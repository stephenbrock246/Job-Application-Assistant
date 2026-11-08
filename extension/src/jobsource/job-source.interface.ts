/**
 * Job source contract.
 *
 * The background worker knows only this interface, so adding a source (an Airtable
 * base, a local JSON file, a REST endpoint) is a new implementation plus a registry
 * entry - never a change to the queue, session or Done logic.
 */

import type { SheetJob, SheetJobPatch } from '@/shared/types/job'
import type { JobSourceId, JobSourceStatus } from '@/shared/types/source'
import type { SheetColumnMap } from '@/shared/types/sheet'

export interface JobSourceReadResult {
  jobs: SheetJob[]
  headers: string[]
  columnMap: SheetColumnMap
}

export interface JobSource {
  readonly id: JobSourceId
  readonly label: string

  /** Cheap, never throws. Drives the connection card. */
  getStatus(): Promise<JobSourceStatus>

  readJobs(): Promise<JobSourceReadResult>

  updateRow(rowNumber: number, patch: SheetJobPatch): Promise<void>

  /**
   * Confirms the row still holds the job we think it does before writing an
   * outcome to it. Rows move; marking the wrong job Applied is unrecoverable.
   */
  verifyRow(rowNumber: number, expectedJobLink: string): Promise<boolean>
}

export class JobSourceNotConfiguredError extends Error {
  code = 'SOURCE_NOT_CONFIGURED'
  constructor(message: string) {
    super(message)
    this.name = 'JobSourceNotConfiguredError'
  }
}
