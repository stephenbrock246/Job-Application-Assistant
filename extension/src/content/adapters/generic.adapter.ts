/**
 * The baseline adapter. Works on any page by using only standard DOM semantics.
 *
 * Every other adapter subclasses this and overrides the one or two methods where
 * a platform's markup defeats the generic approach - never the whole thing.
 */

import { extractJob } from '../extract/job-extractor'
import { scanFields } from '../scanner/form-scanner'
import { classifyAll } from '../scanner/field-classifier'
import { fillFields } from '../autofill/fill-element'
import { fillWidget } from '../autofill/fill-widget'
import { findNextControl } from '../navigation/next-button'
import { detectValidationErrors } from '../validation/validators'
import type { JobSiteAdapter } from './adapter.interface'
import type {
  ApplicationField,
  FillInstruction,
  FillOutcome,
  ValidationError,
} from '@/shared/types/application'
import type { JobInfo } from '@/shared/types/job'

export class GenericAdapter implements JobSiteAdapter {
  readonly name: string = 'generic'

  matches(): boolean {
    return true
  }

  async extractJob(): Promise<JobInfo> {
    return extractJob()
  }

  async scanFields(): Promise<ApplicationField[]> {
    return classifyAll(scanFields())
  }

  /**
   * Native controls are written directly; site-built ones are operated by clicking.
   * Strictly one at a time: a widget opens a popup that the next fill must not race.
   */
  async fillFields(instructions: FillInstruction[]): Promise<FillOutcome[]> {
    const outcomes: FillOutcome[] = []
    for (const instruction of instructions) {
      outcomes.push(instruction.widget ? await fillWidget(instruction) : fillFields([instruction])[0]!)
    }
    return outcomes
  }

  findNextButton(): HTMLElement | null {
    return findNextControl()?.element ?? null
  }

  detectValidationErrors(): ValidationError[] {
    return detectValidationErrors()
  }
}
