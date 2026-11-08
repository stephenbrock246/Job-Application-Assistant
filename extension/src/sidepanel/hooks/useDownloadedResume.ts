/**
 * Picks up a CV the user downloads from ChatGPT themselves.
 *
 * When ChatGPT creates the CV (Settings > AI) and a download finishes whose name
 * has this job's company and looks like a CV (not a cover letter), that file
 * becomes the application's resume: saved in the job folder, then uploaded by
 * autopilot like any approved resume. A newer download replaces an older one.
 */

import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppStateContext'
import { usesGptFile } from '@/ai'
import { sendMessage } from '@/shared/utils/messaging'
import { isRunning, taskKey } from '../lib/ai-activity'
import { adoptResumeFile, findResumeInDownloads, isResumeDownloadFor } from '../lib/gpt-resume'

export function useDownloadedResume(): void {
  const { session, preferences } = useAppState()
  // The listener is registered once; it reads the latest state through this ref.
  const latest = useRef({ session, preferences })
  latest.current = { session, preferences }

  useEffect(() => {
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.state?.current !== 'complete') return
      // Best effort and silent: without file access (or any other problem) nothing changes.
      void (async () => {
        const { session: current, preferences: prefs } = latest.current
        if (!current || !usesGptFile(prefs) || !current.company.trim() || !current.position.trim()) return
        // A ChatGPT run in progress picks the download up itself.
        if (isRunning(taskKey(current.id, 'resume'))) return
        const [item] = await chrome.downloads.search({ id: delta.id })
        if (!item || !isResumeDownloadFor(item.filename, current.company)) return
        // Never replace a resume with an older file.
        if (current.resume && current.resume.generatedAt > Date.parse(item.startTime)) return

        const found = await findResumeInDownloads(current, { since: Date.parse(item.startTime) })
        if (!found) return
        await adoptResumeFile(
          current,
          found,
          (patch) => sendMessage('session/updateWriting', { sessionId: current.id, patch }).then(() => undefined),
          `From your Downloads: "${found.name}".`,
        )
      })().catch(() => undefined)
    }
    chrome.downloads.onChanged.addListener(onChanged)
    return () => chrome.downloads.onChanged.removeListener(onChanged)
  }, [])
}
