/**
 * Content script entry point.
 *
 * Thin by design: it resolves an adapter, calls it, and reports back. All the
 * decisions about *what* to fill, and whether a page change counts as progress,
 * live in the background worker, so the page-side code stays a mechanism rather
 * than a policy.
 */

import { pickAdapter } from './adapters'
import { applyEntryLabel, clickApplyEntry, clickApprovedSubmit, clickNext, findNextControl } from './navigation/next-button'
import { capturePage, embeddedForms, looksLikeConfirmation } from './navigation/page-state'
import {
  awaitChange,
  cancelWait,
  isWatching,
  setBaseline,
  startWatching,
  stopWatching,
} from './navigation/page-watcher'
import { highlightField } from './highlight'
import { attachFile } from './autofill/attach-file'
import { pageHtml } from './diagnostics/snapshot'
import { askChatGpt, clickDownloads, stopChatGpt } from './chatgpt/chatgpt-runner'
import { askClaude, isClaudePage, stopClaude } from './chatgpt/claude-runner'
import { fail, ok } from '@/shared/utils/messaging'
import type { TabEnvelope, TabMessageMap } from '@/shared/types/messages'
import type { FillInstruction, PageFingerprint } from '@/shared/types/application'

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isTabEnvelope(message)) return false

  void (async () => {
    try {
      sendResponse(ok(await handle(message)))
    } catch (error) {
      sendResponse(fail(error, 'CONTENT_FAILED'))
    }
  })()

  return true
})

async function handle(message: TabEnvelope): Promise<unknown> {
  const adapter = pickAdapter()

  switch (message.type) {
    case 'content/ping':
      return { ready: true as const, url: location.href }

    case 'content/extractJob':
      return adapter.extractJob()

    case 'content/scanFields': {
      const fields = await adapter.scanFields()
      const next = findNextControl()
      const page = capturePage(fields)
      // The background now knows this page; the watcher must not report it again.
      setBaseline(page)
      const result: TabMessageMap['content/scanFields']['res'] = {
        url: location.href,
        adapter: adapter.name,
        fields,
        nextButtonLabel: next ? next.label : null,
        nextButtonKind: next ? next.kind : null,
        page,
        embeddedForms: embeddedForms(),
        confirmationDetected: looksLikeConfirmation(fields.length),
        scannedAt: Date.now(),
      }
      return result
    }

    case 'content/fillFields': {
      const payload = message.payload as { instructions: FillInstruction[] }
      return adapter.fillFields(payload.instructions)
    }

    case 'content/detectErrors':
      return adapter.detectValidationErrors()

    case 'content/attachFile': {
      const { fieldId, fileName, mime, base64 } = message.payload as TabMessageMap['content/attachFile']['req']
      // A fresh scan re-registers elements, so the field id resolves on this page.
      await adapter.scanFields()
      return attachFile(fieldId, fileName, mime, base64)
    }

    case 'content/highlightField': {
      const payload = message.payload as { fieldId: string }
      highlightField(payload.fieldId)
      return null
    }

    case 'content/watch': {
      const { enabled } = message.payload as { enabled: boolean }
      if (!enabled) stopWatching()
      else if (!isWatching()) startWatching(reportChange)
      return null
    }

    case 'content/chatgptAsk': {
      // One message for both chat sites; the page decides which runner.
      const { prompt, timeoutMs, file } = message.payload as TabMessageMap['content/chatgptAsk']['req']
      if (isClaudePage()) return askClaude(prompt, timeoutMs, { file: Boolean(file) })
      return askChatGpt(prompt, timeoutMs, { file: Boolean(file) })
    }

    case 'content/chatClickDownloads': {
      const { ref } = message.payload as TabMessageMap['content/chatClickDownloads']['req']
      const clicked = isClaudePage()
        ? clickDownloads(ref, '[data-is-streaming]', '[data-testid="user-message"]')
        : clickDownloads(ref)
      return { clicked }
    }

    case 'content/chatgptStop':
      if (isClaudePage()) stopClaude()
      else stopChatGpt()
      return null

    case 'content/cancelWait':
      cancelWait()
      return null

    case 'content/pageState':
      return { page: capturePage() }

    case 'content/snapshot': {
      // The field list is the most useful part; a page it cannot scan still gets its markup copied.
      const fields = await adapter.scanFields().catch(() => [])
      const { html, truncated } = pageHtml()
      const result: TabMessageMap['content/snapshot']['res'] = {
        url: location.href,
        title: document.title,
        html,
        truncated,
        fields,
        adapter: adapter.name,
        capturedAt: Date.now(),
      }
      return result
    }

    case 'content/clickNext':
      return { ...clickNext(), page: capturePage() }

    case 'content/clickSubmit':
      return { ...clickApprovedSubmit(), page: capturePage() }

    case 'content/clickApply':
      return clickApplyEntry()

    case 'content/findApply':
      return { label: applyEntryLabel() }

    case 'content/awaitChange': {
      const { baseline, timeoutMs } = message.payload as {
        baseline: PageFingerprint
        timeoutMs: number
      }
      return awaitChange(baseline, timeoutMs)
    }

    default:
      throw new Error(`Unknown content message: ${String(message.type)}`)
  }
}

/** The user moved through the form themselves; let the background catch up. */
function reportChange(change: 'modified' | 'new-page', page: PageFingerprint): void {
  chrome.runtime
    .sendMessage({ type: 'page/observed', payload: { change, page } })
    .catch(() => {
      /* background asleep or reloading - the next scan will catch up */
    })
}

function isTabEnvelope(message: unknown): message is TabEnvelope {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof (message as { type: unknown }).type === 'string' &&
    (message as { type: string }).type.startsWith('content/')
  )
}
