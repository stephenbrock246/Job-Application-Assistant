import { useState } from 'react'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { answersSlot, deleteAnswer, upsertAnswer } from '@/storage/answers'
import { CANONICAL_FIELDS, isAutoFillable } from '@/shared/constants/canonical-fields'
import { Badge, Button, Card, EmptyState, Field, Icon, PhaseNotice, Select, TextInput } from '../../components/ui'
import type { QuestionCategory, SavedAnswer } from '@/shared/types/application'

const CATEGORY_TONES: Record<QuestionCategory, 'blue' | 'amber' | 'green' | 'red'> = {
  GLOBAL: 'green',
  JOB_DEPENDENT: 'blue',
  AI_GENERATED: 'amber',
  USER_CONFIRMATION_REQUIRED: 'red',
}

const CATEGORY_LABELS: Record<QuestionCategory, string> = {
  GLOBAL: 'Global',
  JOB_DEPENDENT: 'Job dependent',
  AI_GENERATED: 'AI drafted',
  USER_CONFIRMATION_REQUIRED: 'You confirm',
}

/** Answers that may legitimately be saved as a reusable default. */
const SAVEABLE = CANONICAL_FIELDS.filter((field) => isAutoFillable(field.category))

export function AnswersSettings() {
  const [answers] = useStorageSlot(answersSlot, [] as SavedAnswer[])
  const [adding, setAdding] = useState(false)
  const [key, setKey] = useState(SAVEABLE[0]?.key ?? '')
  const [value, setValue] = useState('')

  const onAdd = async () => {
    const def = SAVEABLE.find((field) => field.key === key)
    if (!def || !value.trim()) return
    await upsertAnswer({
      key: def.key,
      label: def.label,
      value: value.trim(),
      autoFill: true,
      category: def.category,
    })
    setValue('')
    setAdding(false)
  }

  return (
    <div className="space-y-3">
      <PhaseNotice phase="How this is used.">
        A saved answer is reused whenever a form asks a question that maps to the same canonical
        field. Legal attestations, signatures and voluntary demographic questions can never be saved
        here - those always go back to you.
      </PhaseNotice>

      <Card className="p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-slate-900">Saved default answers</h2>
          <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
            <Icon name="plus" className="h-3 w-3" />
            Add
          </Button>
        </div>

        {adding && (
          <div className="mt-3 space-y-2 rounded-lg bg-slate-50 p-2.5">
            <Field label="Question type">
              <Select value={key} onChange={(event) => setKey(event.target.value)}>
                {SAVEABLE.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Answer">
              <TextInput
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="e.g. 2 weeks"
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void onAdd()} disabled={!value.trim()}>
                Save answer
              </Button>
            </div>
          </div>
        )}

        <div className="mt-3">
          {answers.length === 0 ? (
            <EmptyState
              title="No saved answers yet"
              description='When an application asks something the extension does not know, you can tick "Save as default" and the answer lands here.'
            />
          ) : (
            <ul className="space-y-1.5">
              {answers.map((answer) => (
                <li key={answer.key} className="rounded-lg border border-slate-200 px-2.5 py-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-slate-800">{answer.label}</p>
                      <p className="truncate text-xs text-slate-600" title={answer.value}>
                        {answer.value}
                      </p>
                    </div>
                    <Badge tone={CATEGORY_TONES[answer.category]}>
                      {CATEGORY_LABELS[answer.category]}
                    </Badge>
                    <button
                      onClick={() => void deleteAnswer(answer.key)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-500"
                      aria-label={`Delete ${answer.label}`}
                    >
                      <Icon name="trash" className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <label className="mt-1.5 flex items-center gap-1.5 text-2xs text-slate-500">
                    <input
                      type="checkbox"
                      checked={answer.autoFill}
                      onChange={(event) =>
                        void upsertAnswer({ ...answer, autoFill: event.target.checked })
                      }
                      className="h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    Fill automatically without asking
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}
