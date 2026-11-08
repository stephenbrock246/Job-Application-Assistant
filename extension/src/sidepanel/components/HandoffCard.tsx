/**
 * The copy/paste exchange with the user's own ChatGPT / Claude tab.
 *
 *   1. prompt is on the clipboard (copy again if needed) -> open the chat, paste, send
 *   2. copy the chat's whole reply -> paste it here -> Use reply
 *
 * A reply that cannot be used is explained in place and kept in the box, so the
 * user can fix the paste instead of starting over.
 */

import { useEffect, useState } from 'react'
import { getActiveProvider } from '@/ai'
import { copyText, openChat, readClipboard } from '../lib/handoff'
import { relativeTime } from '@/shared/utils/format'
import { Button, Icon, TextArea } from './ui'
import type { AIProvider, PendingAITask } from '@/shared/types/ai'

export function HandoffCard({
  task,
  title,
  onReply,
  onCancel,
}: {
  task: PendingAITask
  title: string
  onReply: (reply: string) => Promise<void>
  onCancel: () => Promise<void>
}) {
  const [provider, setProvider] = useState<AIProvider | null>(null)
  const [reply, setReply] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    void getActiveProvider().then(setProvider)
  }, [])

  const site = provider?.label.replace(/\s*\(.*\)$/, '') ?? 'the chat'

  const copy = async () => {
    try {
      await copyText(task.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('Could not copy - click inside the panel first, then try again.')
    }
  }

  const pasteFromClipboard = async () => {
    try {
      setReply(await readClipboard())
      setError(null)
    } catch {
      setError('Could not read the clipboard. Paste into the box with Ctrl+V instead.')
    }
  }

  const submit = async () => {
    setWorking(true)
    setError(null)
    try {
      await onReply(reply)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That reply could not be used.')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50/50 p-2.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-800">{title}</p>
        <span className="text-2xs text-slate-400">{relativeTime(task.createdAt)}</span>
      </div>

      <ol className="space-y-2 text-2xs leading-relaxed text-slate-600">
        <li>
          <span className="font-semibold text-slate-700">1.</span> The prompt (
          {task.prompt.length.toLocaleString()} characters) is on your clipboard. Paste it into a new{' '}
          {site} chat and send it.
          <div className="mt-1 flex gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => void copy()}>
              <Icon name={copied ? 'check' : 'file'} className="h-3 w-3" />
              {copied ? 'Copied' : 'Copy prompt'}
            </Button>
            {provider?.chatUrl && (
              <Button variant="secondary" size="sm" onClick={() => void openChat(provider)}>
                <Icon name="external" className="h-3 w-3" />
                Open {site}
              </Button>
            )}
          </div>
        </li>
        <li>
          <span className="font-semibold text-slate-700">2.</span> Copy the whole reply and paste it
          here.
          <TextArea
            rows={4}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            placeholder="Paste the reply"
            className="mt-1 font-mono text-[11px]"
          />
        </li>
      </ol>

      {error && (
        <p className="rounded-md border border-red-200 bg-white px-2 py-1.5 text-2xs leading-relaxed text-red-700">
          {error}
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <Button size="sm" disabled={!reply.trim()} loading={working} onClick={() => void submit()}>
          Use reply
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void pasteFromClipboard()}>
          Paste from clipboard
        </Button>
        <button
          onClick={() => void onCancel()}
          className="ml-auto text-2xs text-slate-400 hover:text-slate-600"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
