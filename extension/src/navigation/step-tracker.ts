/**
 * Step bookkeeping for multi-page applications (spec sections 17 and 19).
 *
 * Pure: session + freshly scanned page in, new step state out. The background
 * worker applies the result; the check script exercises it without a browser.
 */

import { comparePages, findMatchingStep } from '@/shared/utils/page-compare'
import type { ApplicationSession, PageFingerprint, StepRecord } from '@/shared/types/application'

/**
 * A page needs at least this many questions to *start* an application. Job
 * postings often carry a lone newsletter or search box, which is not step 1.
 */
export const MIN_FIRST_STEP_FIELDS = 2

export type StepTransition =
  /** Not on an application form yet (e.g. still on the job posting). */
  | 'none'
  /** First application page detected. */
  | 'first'
  /** Still on the current step; its questions may have changed. */
  | 'same'
  /** Moved to a step not seen before. */
  | 'advanced'
  /** Moved back to a step seen earlier. */
  | 'returned'

export interface StepUpdate {
  transition: StepTransition
  currentStep: number
  totalStepsSeen: number
  steps: StepRecord[]
  currentPage?: PageFingerprint
}

export function trackStep(
  session: Pick<ApplicationSession, 'currentPage' | 'steps' | 'currentStep' | 'totalStepsSeen'>,
  page: PageFingerprint,
  counts: { totalFields: number; completedFields: number },
  now = Date.now(),
): StepUpdate {
  const steps = [...(session.steps ?? [])]
  const unchanged: StepUpdate = {
    transition: 'none',
    currentStep: session.currentStep,
    totalStepsSeen: session.totalStepsSeen,
    steps,
    ...(session.currentPage ? { currentPage: session.currentPage } : {}),
  }

  const record = (step: number): StepRecord => ({
    step,
    page,
    firstSeenAt: now,
    lastSeenAt: now,
    ...counts,
  })

  const touch = (step: number) => {
    const index = steps.findIndex((s) => s.step === step)
    if (index === -1) steps.push(record(step))
    else steps[index] = { ...steps[index]!, page, lastSeenAt: now, ...counts }
  }

  if (!session.currentPage) {
    if (page.fieldKeys.length < MIN_FIRST_STEP_FIELDS) return unchanged
    touch(1)
    return { transition: 'first', currentStep: 1, totalStepsSeen: Math.max(1, steps.length), steps, currentPage: page }
  }

  if (comparePages(session.currentPage, page) !== 'new-page') {
    touch(session.currentStep)
    return { ...unchanged, transition: 'same', steps, currentPage: page }
  }

  const earlier = findMatchingStep(
    steps.filter((s) => s.step !== session.currentStep),
    page,
  )
  if (earlier) {
    touch(earlier.step)
    return {
      transition: 'returned',
      currentStep: earlier.step,
      totalStepsSeen: session.totalStepsSeen,
      steps,
      currentPage: page,
    }
  }

  const nextStep = Math.max(session.currentStep, ...steps.map((s) => s.step)) + 1
  touch(nextStep)
  steps.sort((a, b) => a.step - b.step)
  return {
    transition: 'advanced',
    currentStep: nextStep,
    totalStepsSeen: Math.max(session.totalStepsSeen, nextStep),
    steps,
    currentPage: page,
  }
}
