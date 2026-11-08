/**
 * The unattended run's state. Only the background worker writes it; the panel's
 * runner reports progress through messages, and every panel reads it to show
 * the run.
 */

import { defineSlot } from './base'
import type { RunState } from '@/shared/types/run'

export const runSlot = defineSlot<RunState>('autopilotRun', () => ({ mode: 'idle', status: '', items: {} }))
