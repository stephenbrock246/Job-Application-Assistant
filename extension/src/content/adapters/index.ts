/**
 * Adapter registry.
 *
 * Adapters are tried in order and the first match wins, with `GenericAdapter` as
 * the always-matching last entry. Phase 6 adds Greenhouse / Lever / Ashby /
 * Workday / Indeed / LinkedIn entries here - only where the generic path is shown
 * to fail on that platform.
 */

import { GenericAdapter } from './generic.adapter'
import type { JobSiteAdapter } from './adapter.interface'

const ADAPTERS: JobSiteAdapter[] = [
  // Site-specific adapters go here, most specific first.
  new GenericAdapter(),
]

export function pickAdapter(): JobSiteAdapter {
  return ADAPTERS.find((adapter) => adapter.matches()) ?? new GenericAdapter()
}

export type { JobSiteAdapter }
