/**
 * "Information Required" prompt (spec section 8).
 *
 * One card per field the extension refuses to answer on its own. The wording of
 * each card says *why* it is asking, because "we could not work this out" and
 * "we will never answer this for you" are very different situations for the user.
 */

import { useEffect, useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useWriting } from '../hooks/useWriting'
import { cancelTask, describeGeneratedBy, runExclusive, taskKey, useActivity } from '../lib/ai-activity'
import { answerInChat } from '../lib/batch-answers'
import { AICancelledError } from '@/ai'
import { attachToField, isCoverLetterUpload, isResumeUpload, letterFileFor, resumeFileFor } from '../lib/writing-actions'
import { useStorageSlot } from '../hooks/useStorageSlot'
import { masterResumeSlot } from '@/storage/settings'
import type { MasterResumeMeta } from '@/shared/types/settings'
import { CANONICAL_FIELD_BY_KEY, isAutoFillable } from '@/shared/constants/canonical-fields'
import { Badge, Button, Icon, Select, TextArea, TextInput, cx } from './ui'
import type { FieldPlan } from '@/shared/types/application'

/**
 * An upload field: attach the approved tailored resume or cover letter from here.
 * Autopilot does the same on its own; this is the manual way, and the fallback when
 * the page's widget needs a second try.
 */
function FileAttach({ fieldId, label, accept }: { fieldId: string; label: string; accept?: string }) {
  const { session, perform, busy } = useAppState()
  const [master] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  if (!session) return null

  const resumeReady = Boolean(session.resume?.approved && (master || session.resume.source === 'gpt-file'))
  const letterReady = Boolean(session.coverLetter?.approved)
  const wantsLetter = isCoverLetterUpload(label)
  const wantsResume = isResumeUpload(label)

  const attach = (kind: 'resume' | 'letter') =>
    perform(`attach:${fieldId}`, async () => {
      const file =
        kind === 'resume'
          ? await resumeFileFor(session, master, accept)
          : await letterFileFor(session)
      const outcome = await attachToField(session.id, fieldId, file)
      setResult(
        outcome.attached
          ? { ok: true, text: `Attached ${file.fileName}${outcome.error ? ` - ${outcome.error}` : ''}` }
          : { ok: false, text: outcome.error ?? 'The page did not take the file.' },
      )
    })

  const buttons: { kind: 'resume' | 'letter'; text: string }[] = []
  if (resumeReady && !wantsLetter) buttons.push({ kind: 'resume', text: 'Attach tailored resume' })
  if (letterReady && !wantsResume) buttons.push({ kind: 'letter', text: 'Attach cover letter' })

  return (
    <div className="mt-2 space-y-1.5">
      {buttons.length ? (
        <div className="flex flex-wrap gap-1.5">
          {buttons.map((button) => (
            <Button
              key={button.kind}
              variant="secondary"
              size="sm"
              loading={busy === `attach:${fieldId}`}
              onClick={() => void attach(button.kind)}
            >
              <Icon name="file" className="h-3 w-3" />
              {button.text}
            </Button>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-2xs leading-relaxed text-slate-600">
          {wantsLetter
            ? 'Approve your cover letter above and it is attached here automatically.'
            : 'Approve your tailored resume above and it is attached here automatically.'}
        </p>
      )}
      {result && (
        <p className={cx('text-2xs leading-relaxed', result.ok ? 'text-emerald-700' : 'text-red-700')}>{result.text}</p>
      )}
    </div>
  )
}

export function MissingInfoCard({ plan }: { plan: FieldPlan }) {
  const { answerField, highlightField, busy, session, perform, preferences } = useAppState()
  const writing = useWriting()
  const field = plan.field
  const [value, setValue] = useState(plan.value ?? '')
  const [saveAsDefault, setSaveAsDefault] = useState(false)

  const def = field.canonicalField ? CANONICAL_FIELD_BY_KEY.get(field.canonicalField) : undefined
  const canSaveDefault = Boolean(def && isAutoFillable(def.category))
  const isProtected = field.category === 'USER_CONFIRMATION_REQUIRED'
  const isFile = field.type === 'file'
  const isCoverLetter = field.canonicalField === 'coverLetter'
  const canDraft = field.category === 'AI_GENERATED' && !isCoverLetter && !isFile

  const taskKeyName = `answer:${field.id}`
  const drafted = session?.answers?.[field.id]
  const drafting = useActivity(session ? taskKey(session.id, taskKeyName) : null)

  // A freshly drafted answer lands in the editor; the user still has to press Save.
  useEffect(() => {
    if (drafted) setValue(drafted.text)
    // Keyed on generatedAt only: re-running on every render would clobber the user's edits.
  }, [drafted?.generatedAt])

  // This one question to the answers chat (question only); the answer is typed into the field.
  const draft = () =>
    perform(`draft:${field.id}`, async () => {
      if (!session) return
      try {
        await runExclusive(taskKey(session.id, taskKeyName), 'Waiting for the answers chat...', (report, signal) =>
          answerInChat(session, preferences, [field], writing.update, { signal, report }),
        )
      } catch (error) {
        if (error instanceof AICancelledError) return
        throw error
      }
    })

  return (
    <li className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold leading-snug text-slate-800">
            {field.label}
            {field.required && <span className="ml-0.5 text-red-500">*</span>}
          </p>
          {plan.reason && (
            <p className="mt-0.5 text-2xs leading-relaxed text-slate-500">{plan.reason}</p>
          )}
        </div>
        <button
          onClick={() => void highlightField(field.id)}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-white hover:text-brand-600"
          title="Show me this field on the page"
        >
          <Icon name="external" className="h-3.5 w-3.5" />
        </button>
      </div>

      {isProtected ? (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-red-200 bg-white px-2 py-1.5">
          <Icon name="alert" className="mt-px h-3 w-3 shrink-0 text-red-500" />
          <p className="text-2xs leading-relaxed text-red-700">
            Answer this one directly on the page. The extension will not fill legal declarations,
            signatures or voluntary demographic questions for you.
          </p>
        </div>
      ) : isFile ? (
        <FileAttach fieldId={field.id} label={field.label} accept={field.accept} />
      ) : field.custom && (!field.widget || field.valueUnknown) ? (
        // Site-built widget: listed, never typed into. The reason line carries the saved answer.
        <button
          onClick={() => void highlightField(field.id)}
          className="mt-2 flex items-center gap-1 text-2xs font-medium text-brand-600 hover:text-brand-700"
        >
          <Icon name="external" className="h-3 w-3" />
          Show it on the page
        </button>
      ) : (
        <div className="mt-2 space-y-1.5">
          {canDraft && (
            <Button
              variant="secondary"
              size="sm"
              loading={busy === `draft:${field.id}` || Boolean(drafting)}
              onClick={() => void draft()}
              {...(drafting && session ? { onCancel: () => cancelTask(taskKey(session.id, taskKeyName)) } : {})}
            >
              <Icon name="sparkle" className="h-3 w-3" />
              {drafted ? 'Draft again' : 'Draft with AI'}
            </Button>
          )}
          {isCoverLetter && session?.coverLetter?.text && value !== session.coverLetter.text && (
            <Button variant="secondary" size="sm" onClick={() => setValue(session.coverLetter!.text)}>
              Use my cover letter
            </Button>
          )}
          {drafted?.generatedBy && (
            <p className={cx('text-2xs', drafted.generatedBy.fallback ? 'text-amber-700' : 'text-slate-400')}>
              Drafted {describeGeneratedBy(drafted.generatedBy)}
              {drafted.humanized ? ', rewritten by HumanGPT' : ''} - read it as a draft, then make it yours.
            </p>
          )}
          {drafted?.humanized && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
              <span className={drafted.humanized.resisted ? 'text-amber-700' : 'text-slate-500'}>
                HumanGPT ({drafted.humanized.mode})
                {drafted.humanized.aiScore !== null
                  ? ` · GPTZero AI score ${Math.round(drafted.humanized.aiScore * 100)}%`
                  : ''}
                {drafted.humanized.resisted ? ' · still reads as AI' : ''}
                {drafted.humanized.wordsRemaining !== null ? ` · ${drafted.humanized.wordsRemaining} words left` : ''}
              </span>
              {drafted.originalText && value !== drafted.originalText && (
                <button
                  onClick={() => setValue(drafted.originalText!)}
                  className="font-medium text-brand-600 hover:text-brand-700"
                >
                  Use original draft
                </button>
              )}
              {drafted.originalText && value === drafted.originalText && (
                <button onClick={() => setValue(drafted.text)} className="font-medium text-brand-600 hover:text-brand-700">
                  Use HumanGPT version
                </button>
              )}
            </div>
          )}
          {drafted?.humanizerNote && <p className="text-2xs text-amber-700">{drafted.humanizerNote}</p>}
          {drafted?.warnings.map((warning) => (
            <p key={warning.message} className="flex items-start gap-1 text-2xs text-amber-800">
              <Icon name="alert" className="mt-px h-3 w-3 shrink-0" />
              {warning.message}
            </p>
          ))}
          {/* A list to pick from when the options are known; otherwise (type-and-pick) free text. */}
          {(field.type === 'select' || field.type === 'radio') && (field.options?.length ?? 0) > 0 ? (
            <Select value={value} onChange={(event) => setValue(event.target.value)}>
              <option value="">Select an option...</option>
              {(field.options ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          ) : field.type === 'textarea' ? (
            <TextArea
              rows={3}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Type your answer"
            />
          ) : (
            <TextInput
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Select or type..."
            />
          )}

          <label
            className={cx(
              'flex items-center gap-1.5 text-2xs',
              canSaveDefault ? 'text-slate-600' : 'text-slate-300',
            )}
            title={
              canSaveDefault
                ? 'Reuse this answer for the same question on future applications'
                : 'This field cannot be saved as a reusable default'
            }
          >
            <input
              type="checkbox"
              disabled={!canSaveDefault}
              checked={saveAsDefault && canSaveDefault}
              onChange={(event) => setSaveAsDefault(event.target.checked)}
              className="h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
            />
            Save as default
          </label>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!value.trim()}
              loading={busy === `answer:${field.id}`}
              onClick={() => {
                void answerField({
                  fieldId: field.id,
                  value: value.trim(),
                  saveAsDefault: saveAsDefault && canSaveDefault,
                  label: field.label,
                  ...(field.canonicalField ? { canonicalField: field.canonicalField } : {}),
                })
              }}
            >
              Save &amp; continue
            </Button>
            {field.canonicalField && (
              <Badge tone="neutral">{field.canonicalField}</Badge>
            )}
          </div>
        </div>
      )}
    </li>
  )
}
