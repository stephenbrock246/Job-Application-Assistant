/**
 * Job site adapter contract (spec section 20).
 *
 * One adapter handles one family of sites. `GenericAdapter` is the baseline and
 * handles everything; a site-specific adapter exists only when the generic path
 * demonstrably fails on that platform, and it overrides just the methods it needs.
 */

import type { ApplicationField, FillInstruction, FillOutcome, ValidationError } from '@/shared/types/application'
import type { JobInfo } from '@/shared/types/job'

export interface JobSiteAdapter {
  /** Short identifier reported back to the panel, e.g. "generic", "greenhouse". */
  readonly name: string

  /** True when this adapter should handle the current page. */
  matches(): boolean

  extractJob(): Promise<JobInfo>
  scanFields(): Promise<ApplicationField[]>
  fillFields(instructions: FillInstruction[]): Promise<FillOutcome[]>
  findNextButton(): HTMLElement | null
  detectValidationErrors(): ValidationError[]
}
