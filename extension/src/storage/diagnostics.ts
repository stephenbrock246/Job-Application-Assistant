/**
 * Storage for the black-box recorder.
 *
 * The timeline and the incident list are small slots. Each incident's screenshot
 * and page copy (hundreds of KB) sit under their own key, so listing incidents or
 * appending to the timeline never rewrites them.
 *
 * Only the background worker writes here (one writer, no lost updates); the panel
 * reads to show counts and to build the downloadable report.
 */

import { defineSlot } from './base'
import type { IncidentDetail, IncidentSummary, LogEvent } from '@/shared/types/diagnostics'

/** Timeline entries kept; older ones drop off. */
export const LOG_LIMIT = 3000
/** Incidents kept with their screenshots; the oldest is deleted first. */
export const INCIDENT_LIMIT = 40

export const flightLogSlot = defineSlot<LogEvent[]>('diagnosticsLog', () => [])
export const incidentsSlot = defineSlot<IncidentSummary[]>('diagnosticsIncidents', () => [])

export function incidentKey(id: string): string {
  return `diagnosticsIncident:${id}`
}

export async function getIncidentDetail(id: string): Promise<IncidentDetail | null> {
  const key = incidentKey(id)
  const stored = await chrome.storage.local.get(key)
  return (stored[key] as IncidentDetail | undefined) ?? null
}

export async function setIncidentDetail(detail: IncidentDetail): Promise<void> {
  await chrome.storage.local.set({ [incidentKey(detail.id)]: detail })
}

export async function removeIncidentDetails(ids: string[]): Promise<void> {
  if (ids.length) await chrome.storage.local.remove(ids.map(incidentKey))
}
