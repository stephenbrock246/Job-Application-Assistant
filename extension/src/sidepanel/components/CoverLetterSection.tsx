/**
 * Cover letter for the current application (cover letter addendum).
 *
 * Separate prompt, separate result. The text is always editable before it goes
 * anywhere; "Insert into form" only targets a field classified as a cover letter,
 * never a short "why this role" question.
 */

import { useEffect, useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useWriting, type FinishTask } from '../hooks/useWriting'
import { HandoffCard } from './HandoffCard'
import { composeCoverLetter, finishCoverLetter, withLetterChecks } from '@/resume/cover-letter'
import { copyText } from '../lib/handoff'
import { jobFolderPath, previewPdf } from '../lib/files'
import { saveLetterPdf } from '../lib/writing-actions'
import { cancelTask, describeGeneratedBy, taskKey, useActivity } from '../lib/ai-activity'
import { ActivityLine } from './ResumeSection'
import { usesGptFile } from '@/ai'
import { Badge, Button, Icon, Notice, SubTitle, TextArea, TextButton } from './ui'
import type { CoverLetterState } from '@/shared/types/resume'

const TASK_KEY = 'coverLetter'

export function CoverLetterSection() {
  const { session, perform, busy, preferences } = useAppState()
  const writing = useWriting()
  const [instructions, setInstructions] = useState('')
  const [showInstructions, setShowInstructions] = useState(false)
  const activity = useActivity(session ? taskKey(session.id, TASK_KEY) : null)

  if (!session) return null

  const pending = writing.pending[TASK_KEY]
  const letter = session.coverLetter
  const hasJd = Boolean(session.jobInfo?.description.trim())

  const finishLetter: FinishTask = async (task, reply, meta) => ({
    coverLetter: {
      ...(await finishCoverLetter(session, task, reply)),
      ...(meta?.generatedBy ? { generatedBy: meta.generatedBy } : {}),
    },
  })

  const generate = (extra?: string) =>
    perform('letter:generate', async () => {
      const text = (extra ?? instructions).trim()
      await writing.start(
        TASK_KEY,
        () => composeCoverLetter(session, text ? { instructions: text } : {}),
        finishLetter,
      )
    })

  // ChatGPT mode: its letter is listed with the CV; here only its text, folded away.
  if (usesGptFile(preferences) && !activity && !pending) {
    if (letter?.source === 'gpt-file') {
      return (
        <details className="px-3 pb-2.5">
          <summary className="cursor-pointer text-2xs font-medium text-slate-500 hover:text-slate-700">
            Cover letter text (pasted into text boxes)
          </summary>
          <div className="mt-2">
            <LetterEditor letter={letter} onRegenerate={() => generate()} />
          </div>
        </details>
      )
    }
    if (!letter) {
      return session.resume?.source === 'gpt-file' ? (
        <div className="px-3 pb-2.5">
          <button
            onClick={() => void generate()}
            disabled={!hasJd || busy === 'letter:generate'}
            className="text-2xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
          >
            {busy === 'letter:generate' ? 'Writing...' : 'No cover letter from the tailoring chat - write one in ChatGPT'}
          </button>
        </div>
      ) : null
    }
  }

  let body: React.ReactNode
  if (activity) {
    body = <ActivityLine message={activity} onCancel={() => cancelTask(taskKey(session.id, TASK_KEY))} />
  } else if (pending) {
    body = (
      <HandoffCard
        task={pending}
        title="Cover letter prompt ready"
        onReply={(reply) => writing.complete(TASK_KEY, reply, finishLetter)}
        onCancel={() => writing.cancel(TASK_KEY)}
      />
    )
  } else if (letter) {
    body = <LetterEditor letter={letter} onRegenerate={() => generate(letter.instructions ?? '')} />
  } else {
    body = (
      <div className="space-y-2">
        {showInstructions ? (
          <TextArea
            rows={2}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder='e.g. "Keep it under 200 words" or "Focus on my NestJS and PostgreSQL work"'
          />
        ) : (
          <button
            onClick={() => setShowInstructions(true)}
            className="text-2xs font-medium text-brand-600 hover:text-brand-700"
          >
            + Add instructions for this job
          </button>
        )}
        {!hasJd && <p className="text-2xs text-amber-700">Extract the job description first (Scan page above).</p>}
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasJd}
          loading={busy === 'letter:generate'}
          onClick={() => void generate()}
        >
          <Icon name="sparkle" className="h-3 w-3" />
          Generate cover letter
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2 px-3 pb-2.5 pt-1">
      <SubTitle right={letter && !pending ? <Badge tone={letter.approved ? 'green' : 'amber'}>{letter.approved ? 'Approved' : 'Draft'}</Badge> : undefined}>
        Cover letter
      </SubTitle>
      {body}
    </div>
  )
}

function LetterEditor({ letter, onRegenerate }: { letter: CoverLetterState; onRegenerate: () => void }) {
  const { session, perform, busy, answerField } = useAppState()
  const writing = useWriting()
  const [text, setText] = useState(letter.text)
  const [copied, setCopied] = useState(false)
  // An approved letter stays folded to one line; a draft opens for review.
  const [open, setOpen] = useState(!letter.approved)

  // A regenerated letter replaces the editor contents.
  useEffect(() => setText(letter.text), [letter.generatedAt, letter.text])
  useEffect(() => setOpen(!letter.approved), [letter.generatedAt])

  if (!session) return null

  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const dirty = text !== letter.text

  // Only a field the classifier identified as a cover letter is a valid target.
  const target = [...(session.lastReport?.ask ?? []), ...(session.lastReport?.skipped ?? [])].find(
    (plan) =>
      plan.field.canonicalField === 'coverLetter' && (plan.field.type === 'textarea' || plan.field.type === 'text'),
  )?.field

  const persist = async (patch: Partial<CoverLetterState>) => {
    // Edited text no longer matches ChatGPT's file: from now on the letter is made from the text.
    const { source: _source, ...fromText } = letter
    const base = text !== letter.text ? fromText : letter
    const next = await withLetterChecks(session, { ...base, text, ...patch })
    await writing.update({ coverLetter: next })
    return next
  }

  const copy = () =>
    perform('letter:copy', async () => {
      await copyText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  const savePdf = () =>
    perform('letter:pdf', async () => {
      const file = await saveLetterPdf(session, text)
      await previewPdf(file)
      await persist({ pdfFileName: file.fileName })
    })

  const meta = (
    <p className="truncate text-2xs text-slate-400">
      {words} words{letter.instructions ? ' · with job-specific instructions' : ''}
      {letter.generatedBy && (
        <span className={letter.generatedBy.fallback ? 'text-amber-700' : undefined}> · {describeGeneratedBy(letter.generatedBy)}</span>
      )}
    </p>
  )

  // Folded: one line with the actions used most.
  if (!open) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{meta}</div>
          <TextButton onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</TextButton>
          <TextButton onClick={() => void savePdf()} disabled={busy === 'letter:pdf'}>
            {busy === 'letter:pdf' ? 'Saving...' : 'Save PDF'}
          </TextButton>
          <TextButton onClick={() => setOpen(true)}>View / edit</TextButton>
        </div>
        {letter.warnings.length > 0 && <Notice>{letter.warnings.map((w) => w.message).join(' ')}</Notice>}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <TextArea
        rows={10}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          if (dirty) void perform('letter:edit', async () => void (await persist({ approved: false })))
        }}
        className="text-[11px] leading-relaxed"
      />
      {meta}

      {letter.warnings.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          {letter.warnings.map((warning) => (
            <li key={warning.message} className="flex items-start gap-1 text-2xs text-amber-800">
              <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      {letter.pdfFileName && (
        <p className="truncate text-2xs text-emerald-700" title={`Downloads/${jobFolderPath(session.company, session.position)}/${letter.pdfFileName}`}>
          Saved {letter.pdfFileName}
        </p>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'file'} className="h-3 w-3" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="secondary" size="sm" loading={busy === 'letter:pdf'} onClick={() => void savePdf()}>
          Save PDF
        </Button>
        {target && (
          <Button
            variant="secondary"
            size="sm"
            className="col-span-2"
            title={`Fill "${target.label}"`}
            loading={busy === `answer:${target.id}`}
            onClick={() =>
              void answerField({ fieldId: target.id, value: text, saveAsDefault: false, label: target.label, canonicalField: 'coverLetter' })
            }
          >
            Insert into "{target.label}"
          </Button>
        )}
        {(!letter.approved || dirty) && (
          <Button
            variant="success"
            size="sm"
            className="col-span-2"
            onClick={() =>
              void perform('letter:approve', async () => {
                await persist({ approved: true })
                setOpen(false)
              })
            }
          >
            <Icon name="check" className="h-3 w-3" />
            Approve
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <TextButton onClick={onRegenerate}>Regenerate</TextButton>
        {letter.approved && !dirty && (
          <TextButton tone="muted" onClick={() => setOpen(false)}>
            Fold
          </TextButton>
        )}
      </div>
    </div>
  )
}
