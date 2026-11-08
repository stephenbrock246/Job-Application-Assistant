/**
 * Tailored resume for the current application (spec sections 10-14).
 *
 *   choose profile (+ one-off instructions) -> prompt -> reply
 *   -> review every changed paragraph (edit / revert, fabrication warnings)
 *   -> Preview PDF, Approve & save (.docx with the master's exact layout + approximate .pdf)
 */

import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useStorageSlot } from '../hooks/useStorageSlot'
import { useWriting, type FinishTask } from '../hooks/useWriting'
import { HandoffCard } from './HandoffCard'
import { composeTailoring, finishTailoring, recheckEdits } from '@/resume/resume-tailor'
import { generatePdf } from '@/resume/resume-generator'
import { jobFolderPath, openSaved, previewPdf } from '../lib/files'
import { approveAndSaveResume } from '../lib/writing-actions'
import { cancelTask, describeGeneratedBy, runExclusive, taskKey, useActivity } from '../lib/ai-activity'
import { gptLetterFile, gptResumeFile, tailorWithGptFile } from '../lib/gpt-resume'
import { AICancelledError, usesChatContent, usesGptFile } from '@/ai'
import { tailorWithChatContent } from '../lib/chat-tailor'
import { fileOwnerName } from '@/storage/applicant-profile'
import { masterResumeSlot } from '@/storage/settings'
import { kindOf, promptsSlot } from '@/storage/prompts'
import { Badge, Button, CancelButton, Icon, Select, Spinner, SubTitle, TextArea, TextButton, cx } from './ui'
import type { ParagraphEdit, TailoredResumeState } from '@/shared/types/resume'
import type { MasterResumeMeta, PromptProfile } from '@/shared/types/settings'

const TASK_KEY = 'resume'

export function ResumeSection({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { session, perform, busy, preferences } = useAppState()
  const [master] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)
  const [profiles] = useStorageSlot(promptsSlot, [] as PromptProfile[])
  const writing = useWriting()
  const [editingOptions, setEditingOptions] = useState(false)
  // Shared with autopilot: whoever is tailoring, this section shows it and blocks a second run.
  const activity = useActivity(session ? taskKey(session.id, TASK_KEY) : null)

  if (!session) return null

  const pending = writing.pending[TASK_KEY]
  const resume = session.resume
  const hasJd = Boolean(session.jobInfo?.description.trim())

  const finishResume: FinishTask = async (task, reply, meta) => {
    const { state, ignored } = await finishTailoring(session, task, reply)
    return {
      resume: {
        ...state,
        ...(meta?.generatedBy ? { generatedBy: meta.generatedBy } : {}),
        warnings: [...ignored.map((message) => ({ message: `Ignored: ${message}` })), ...state.warnings],
      },
      resumeApproved: false,
      tailoredResume: null,
    }
  }

  // The tailoring chat writes the text; the extension builds the files from the master.
  const chatMode = usesChatContent(preferences)
  const tailorInChat = () =>
    perform('resume:generate', async () => {
      try {
        await runExclusive(taskKey(session.id, TASK_KEY), 'Sending the job to your chat...', (report, signal) =>
          tailorWithChatContent(session, preferences, writing.update, { signal, report }),
        )
        setEditingOptions(false)
      } catch (error) {
        if (error instanceof AICancelledError) return
        throw error
      }
    })

  const generate = (options: { promptProfileId?: string; instructions?: string }) =>
    chatMode
      ? tailorInChat()
      : perform('resume:generate', async () => {
          await writing.start(TASK_KEY, () => composeTailoring(session, options), finishResume)
          setEditingOptions(false)
        })

  // ChatGPT creates the PDF itself from the job description.
  const gptMode = usesGptFile(preferences)
  const createInGpt = () =>
    perform('resume:generate', async () => {
      try {
        await runExclusive(taskKey(session.id, TASK_KEY), 'Sending the job description to ChatGPT...', (report, signal) =>
          tailorWithGptFile(session, preferences, writing.update, { signal, report }),
        )
      } catch (error) {
        if (error instanceof AICancelledError) return
        throw error
      }
    })

  let body: React.ReactNode

  if (activity) {
    body = <ActivityLine message={activity} onCancel={() => cancelTask(taskKey(session.id, TASK_KEY))} />
  } else if (resume?.source === 'gpt-file') {
    body = <GptFileReview resume={resume} onCreateAgain={() => void createInGpt()} />
  } else if (gptMode && !resume) {
    body = (
      <div className="space-y-1.5">
        <Button className="w-full" disabled={!hasJd} loading={busy === 'resume:generate'} onClick={() => void createInGpt()}>
          <Icon name="sparkle" className="h-3.5 w-3.5" />
          Tailor CV &amp; cover letter
        </Button>
        <p className="text-2xs text-slate-400">
          {hasJd
            ? 'Your ChatGPT chat writes them; both are saved to the job folder and added to the form.'
            : 'Needs the job description - press Re-scan above, or Paste it.'}
        </p>
      </div>
    )
  } else if (!master || (!master.text.trim() && !master.docxBase64)) {
    body = (
      <p className="text-xs leading-relaxed text-slate-500">
        Add your master resume first.{' '}
        <button onClick={() => onOpenSettings('resume')} className="font-medium text-brand-600 hover:text-brand-700">
          Open resume settings
        </button>
      </p>
    )
  } else if (chatMode && !resume) {
    body = (
      <div className="space-y-1.5">
        <Button className="w-full" disabled={!hasJd} loading={busy === 'resume:generate'} onClick={() => void tailorInChat()}>
          <Icon name="sparkle" className="h-3.5 w-3.5" />
          Tailor CV &amp; cover letter
        </Button>
        <p className="text-2xs text-slate-400">
          {hasJd
            ? 'Your chat writes the headline, summary, skills and experience; the CV and cover letter PDFs are built from your master resume.'
            : 'Needs the job description - press Re-scan above, or Paste it.'}
        </p>
      </div>
    )
  } else if (pending) {
    body = (
      <HandoffCard
        task={pending}
        title="Tailoring prompt ready"
        onReply={(reply) => writing.complete(TASK_KEY, reply, finishResume)}
        onCancel={() => writing.cancel(TASK_KEY)}
      />
    )
  } else if (!resume || editingOptions) {
    body = (
      <GenerateForm
        profiles={profiles.filter((p) => kindOf(p) === 'resume')}
        initial={resume}
        disabledReason={hasJd ? null : 'Extract the job description first (Scan page above).'}
        busy={busy === 'resume:generate'}
        onGenerate={generate}
        onCancel={resume ? () => setEditingOptions(false) : undefined}
      />
    )
  } else {
    body = (
      <ResumeReview
        resume={resume}
        master={master}
        onRegenerate={() =>
          generate({
            promptProfileId: resume.promptProfileId,
            ...(resume.instructions ? { instructions: resume.instructions } : {}),
          })
        }
        {...(chatMode ? {} : { onEditInstructions: () => setEditingOptions(true) })}
      />
    )
  }

  // ChatGPT's own files speak for themselves; edits to the master need a review state.
  const showBadge = resume && !pending && resume.source !== 'gpt-file'
  return (
    <div className="space-y-2 px-3 py-2.5">
      {showBadge && (
        <SubTitle right={<Badge tone={resume.approved ? 'green' : 'amber'}>{resume.approved ? 'Approved' : 'Needs review'}</Badge>}>
          CV
        </SubTitle>
      )}
      {body}
    </div>
  )
}

// ---------------------------------------------------------------------------

/** Live progress of an AI call - "Gemini is busy - retrying (2/5) in 4s..." - with Cancel. */
export function ActivityLine({ message, onCancel }: { message: string; onCancel?: () => void }) {
  const cancelling = message === 'Cancelling...'
  return (
    <div className="flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50/60 px-2.5 py-2">
      <Spinner className="h-3 w-3 shrink-0 text-brand-700" />
      <p className="min-w-0 flex-1 text-2xs leading-relaxed text-brand-800">{message}</p>
      {onCancel && !cancelling && <CancelButton onClick={onCancel} />}
    </div>
  )
}

function GenerateForm({
  profiles,
  initial,
  disabledReason,
  busy,
  onGenerate,
  onCancel,
}: {
  profiles: PromptProfile[]
  initial: TailoredResumeState | undefined
  disabledReason: string | null
  busy: boolean
  onGenerate: (options: { promptProfileId?: string; instructions?: string }) => void
  onCancel?: () => void
}) {
  const fallback = profiles.find((p) => p.isDefault) ?? profiles[0]
  const [profileId, setProfileId] = useState(initial?.promptProfileId ?? fallback?.id ?? '')
  const [instructions, setInstructions] = useState(initial?.instructions ?? '')
  const [showInstructions, setShowInstructions] = useState(Boolean(initial?.instructions))

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="label">Tailoring profile</span>
        <Select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </Select>
      </label>

      {showInstructions ? (
        <label className="block">
          <span className="label">Instructions for this job only</span>
          <TextArea
            rows={3}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder='e.g. "Lead with my payments work" - not saved to the profile'
          />
        </label>
      ) : (
        <button
          onClick={() => setShowInstructions(true)}
          className="text-2xs font-medium text-brand-600 hover:text-brand-700"
        >
          + Edit for this job
        </button>
      )}

      {disabledReason && <p className="text-2xs text-amber-700">{disabledReason}</p>}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={Boolean(disabledReason)}
          loading={busy}
          onClick={() =>
            onGenerate({
              ...(profileId ? { promptProfileId: profileId } : {}),
              ...(instructions.trim() ? { instructions } : {}),
            })
          }
        >
          <Icon name="sparkle" className="h-3 w-3" />
          {initial ? 'Regenerate' : 'Tailor resume'}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

function ResumeReview({
  resume,
  master,
  onRegenerate,
  onEditInstructions,
}: {
  resume: TailoredResumeState
  master: MasterResumeMeta
  onRegenerate: () => void
  /** Absent when the chat writes the CV: its instructions live in the chat itself. */
  onEditInstructions?: () => void
}) {
  const { session, perform, busy } = useAppState()
  const writing = useWriting()
  const [downloadId, setDownloadId] = useState<number | null>(null)

  if (!session) return null

  const stale = resume.masterUploadedAt !== master.uploadedAt
  const isDocx = master.format === 'docx' && Boolean(master.docxBase64)
  const jd = session.jobInfo?.description ?? ''
  const generalWarnings = resume.warnings.filter((w) => w.paragraphId === undefined)

  const saveEdits = (edits: ParagraphEdit[]) =>
    perform('resume:edit', async () => {
      // Any change after approval needs a fresh review and a fresh save.
      await writing.update({
        resume: { ...recheckEdits({ ...resume, edits }, master, jd), approved: false },
        resumeApproved: false,
      })
    })

  const approveAndSave = () =>
    perform('resume:save', async () => {
      const { docxDownloadId } = await approveAndSaveResume(session, master, writing.update)
      setDownloadId(docxDownloadId)
    })

  const preview = () =>
    perform('resume:preview', async () => {
      await previewPdf(await generatePdf(master, resume.edits, await fileOwnerName()))
    })

  return (
    <div className="space-y-2">
      {stale && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-2xs text-red-700">
          Your master resume changed after this was generated. Regenerate before saving.
        </p>
      )}

      <p className="text-2xs text-slate-500">
        {resume.edits.length} change{resume.edits.length === 1 ? '' : 's'}
        {' · '}
        {resume.generatedBy ? (
          <span className={resume.generatedBy.fallback ? 'text-amber-700' : undefined}>{describeGeneratedBy(resume.generatedBy)}</span>
        ) : (
          resume.promptProfileName
        )}
        {resume.instructions ? ' · with job-specific instructions' : ''}
        {isDocx ? '' : ' · PDF only (text master)'}
      </p>

      {resume.changeNotes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-2xs leading-relaxed text-slate-600">
          {resume.changeNotes.slice(0, 5).map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}

      {generalWarnings.length > 0 && (
        <ul className="space-y-0.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5">
          {generalWarnings.map((warning, index) => (
            <li key={index} className="text-2xs text-amber-800">
              {warning.message}
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-lg border border-slate-200 bg-white" open={!resume.approved}>
        <summary className="cursor-pointer px-2.5 py-1.5 text-2xs font-medium text-slate-600">
          Review changes
          {resume.warnings.some((w) => w.paragraphId !== undefined) && (
            <span className="ml-1.5 text-amber-600">
              ({resume.warnings.filter((w) => w.paragraphId !== undefined).length} to check)
            </span>
          )}
        </summary>
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {resume.edits.map((edit) => (
            <EditRow
              key={edit.id}
              edit={edit}
              warnings={resume.warnings.filter((w) => w.paragraphId === edit.id).map((w) => w.message)}
              onChange={(text) =>
                void saveEdits(resume.edits.map((e) => (e.id === edit.id ? { ...e, text } : e)))
              }
              onRevert={() => void saveEdits(resume.edits.filter((e) => e.id !== edit.id))}
            />
          ))}
        </ul>
      </details>

      {resume.approved && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 px-2.5 py-1.5">
          <Icon name="file" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-2xs font-medium text-emerald-900" title={[resume.docxFileName, resume.pdfFileName].filter(Boolean).join('\n')}>
              {[resume.pdfFileName, resume.docxFileName ? '.docx' : ''].filter(Boolean).join(' + ')}
            </p>
            <p className="truncate text-2xs text-emerald-700/80" title={`Downloads/${jobFolderPath(session.company, session.position)}`}>
              Downloads/{jobFolderPath(session.company, session.position)}
            </p>
          </div>
          {downloadId !== null && (
            <TextButton onClick={() => void perform('resume:open', () => openSaved(downloadId))}>Open</TextButton>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5">
        <Button variant="secondary" size="sm" loading={busy === 'resume:preview'} onClick={() => void preview()}>
          Preview PDF
        </Button>
        <Button
          variant={resume.approved ? 'secondary' : 'success'}
          size="sm"
          disabled={stale}
          loading={busy === 'resume:save'}
          onClick={() => void approveAndSave()}
        >
          <Icon name="check" className="h-3 w-3" />
          {resume.approved ? 'Save again' : 'Approve & save'}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <TextButton onClick={onRegenerate}>Regenerate</TextButton>
        {onEditInstructions && <TextButton onClick={onEditInstructions}>Change instructions</TextButton>}
      </div>
    </div>
  )
}

/** The files ChatGPT created for this job: one row each, with a preview. */
function GptFileReview({ resume, onCreateAgain }: { resume: TailoredResumeState; onCreateAgain: () => void }) {
  const { session, perform, busy } = useAppState()
  if (!session) return null
  const letter = session.coverLetter?.source === 'gpt-file' ? session.coverLetter : null

  return (
    <div className="space-y-1.5">
      <ul className="divide-y divide-emerald-100 overflow-hidden rounded-lg border border-emerald-200 bg-emerald-50/60">
        <FileRow
          label="CV"
          fileName={resume.pdfFileName ?? resume.docxFileName ?? ''}
          canPreview={Boolean(resume.pdfFileName)}
          busy={busy === 'resume:preview'}
          onPreview={() => void perform('resume:preview', async () => previewPdf(await gptResumeFile(session)))}
        />
        {letter && (
          <FileRow
            label="Cover letter"
            fileName={letter.pdfFileName ?? letter.docxFileName ?? ''}
            canPreview={Boolean(letter.pdfFileName)}
            busy={busy === 'letter:preview'}
            onPreview={() => void perform('letter:preview', async () => previewPdf(await gptLetterFile(session)))}
          />
        )}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-2xs text-slate-400" title={`Downloads/${jobFolderPath(session.company, session.position)}`}>
          Saved to Downloads/{jobFolderPath(session.company, session.position)}
        </p>
        <TextButton onClick={onCreateAgain} disabled={busy === 'resume:generate'}>
          Redo
        </TextButton>
      </div>
    </div>
  )
}

function FileRow({
  label,
  fileName,
  canPreview,
  busy,
  onPreview,
}: {
  label: string
  fileName: string
  canPreview: boolean
  busy: boolean
  onPreview: () => void
}) {
  return (
    <li className="flex items-center gap-2 px-2.5 py-1.5">
      <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      <span className="w-20 shrink-0 text-2xs font-medium text-emerald-900">{label}</span>
      <span className="min-w-0 flex-1 truncate text-2xs text-emerald-800" title={fileName}>
        {fileName}
      </span>
      {canPreview && (
        <button onClick={onPreview} disabled={busy} className="shrink-0 text-2xs font-medium text-brand-600 hover:text-brand-700">
          {busy ? '...' : 'View'}
        </button>
      )}
    </li>
  )
}

function EditRow({
  edit,
  warnings,
  onChange,
  onRevert,
}: {
  edit: ParagraphEdit
  warnings: string[]
  onChange: (text: string) => void
  onRevert: () => void
}) {
  const [text, setText] = useState(edit.text)

  return (
    <li className={cx('space-y-1 px-2.5 py-2', warnings.length > 0 && 'bg-amber-50/50')}>
      {edit.insert ? (
        <p className="text-2xs font-medium text-emerald-700">Added</p>
      ) : (
        <p className="whitespace-pre-wrap text-2xs text-slate-400 line-through">{edit.original}</p>
      )}
      {edit.removed ? (
        <p className="text-2xs font-medium text-red-600">Removed from the tailored resume</p>
      ) : (
        <TextArea
          rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (text.trim() && text !== edit.text) onChange(text)
          }}
          className="text-[11px] leading-relaxed"
        />
      )}
      {warnings.map((warning) => (
        <p key={warning} className="flex items-start gap-1 text-2xs text-amber-800">
          <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
          {warning}
        </p>
      ))}
      <button onClick={onRevert} className="text-2xs text-slate-400 hover:text-slate-600">
        {edit.insert ? 'Remove' : 'Keep original'}
      </button>
    </li>
  )
}
