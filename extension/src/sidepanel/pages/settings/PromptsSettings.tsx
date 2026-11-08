import { useEffect, useState } from 'react'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import {
  createPrompt,
  deletePrompt,
  duplicatePrompt,
  kindOf,
  promptsSlot,
  savePrompt,
  setDefaultPrompt,
} from '@/storage/prompts'
import {
  createDefaultCoverLetterProfile,
  createDefaultPromptProfile,
} from '@/shared/constants/defaults'
import { Badge, Button, Card, Field, Icon, Select, TextArea, TextInput, cx } from '../../components/ui'
import type { PromptKind, PromptProfile } from '@/shared/types/settings'

const KINDS: { id: PromptKind; label: string; hint: string; fresh: () => PromptProfile }[] = [
  {
    id: 'resume',
    label: 'Resume tailoring',
    hint: 'Combined with your master resume and the job description every time a resume is tailored.',
    fresh: createDefaultPromptProfile,
  },
  {
    id: 'coverLetter',
    label: 'Cover letter',
    hint: 'Used for every cover letter. Instructions added for one job never change it.',
    fresh: createDefaultCoverLetterProfile,
  },
]

export function PromptsSettings() {
  const [kind, setKind] = useState<PromptKind>('resume')

  return (
    <div className="space-y-3 pb-16">
      <div className="flex gap-1 rounded-lg bg-slate-200/70 p-0.5">
        {KINDS.map((item) => (
          <button
            key={item.id}
            onClick={() => setKind(item.id)}
            className={cx(
              'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
              kind === item.id ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <PromptEditor key={kind} kind={kind} />
    </div>
  )
}

function PromptEditor({ kind }: { kind: PromptKind }) {
  const config = KINDS.find((k) => k.id === kind)!
  const [all] = useStorageSlot(promptsSlot, [createDefaultPromptProfile(), createDefaultCoverLetterProfile()])
  const profiles = all.filter((p) => kindOf(p) === kind)
  const [selectedId, setSelectedId] = useState<string>('')
  const [draft, setDraft] = useState<PromptProfile | null>(null)

  const selected = profiles.find((p) => p.id === selectedId) ?? profiles.find((p) => p.isDefault) ?? profiles[0] ?? null

  useEffect(() => {
    if (selected && (!draft || draft.id !== selected.id)) {
      setDraft({ ...selected })
      setSelectedId(selected.id)
    }
  }, [selected, draft])

  if (!draft || !selected) return null

  const dirty = draft.name !== selected.name || draft.prompt !== selected.prompt

  return (
    <>
      <p className="text-xs leading-relaxed text-slate-500">{config.hint}</p>

      <Card className="space-y-2.5 p-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-slate-900">Profile</h2>
          {selected.isDefault && <Badge tone="green">Default</Badge>}
        </div>

        <Select
          value={selected.id}
          onChange={(event) => {
            setSelectedId(event.target.value)
            const next = profiles.find((p) => p.id === event.target.value)
            if (next) setDraft({ ...next })
          }}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </Select>

        <div className="flex flex-wrap gap-1.5">
          <Button variant="secondary" size="sm" onClick={() => void duplicatePrompt(selected.id)}>
            Duplicate
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={selected.isDefault}
            onClick={() => void setDefaultPrompt(selected.id)}
          >
            Set default
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void createPrompt(kind, 'New profile', config.fresh().prompt).then((created) => {
                setSelectedId(created.id)
                setDraft({ ...created })
              })
            }}
          >
            <Icon name="plus" className="h-3 w-3" />
            New
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={profiles.length <= 1}
            onClick={() => void deletePrompt(selected.id)}
          >
            Delete
          </Button>
        </div>
      </Card>

      <Card className="space-y-2.5 p-3">
        <Field label="Profile name">
          <TextInput value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </Field>

        <Field
          label={kind === 'resume' ? 'Tailoring prompt' : 'Cover letter prompt'}
          hint="Reply-format instructions are added automatically - write only what you want."
        >
          <TextArea
            rows={16}
            value={draft.prompt}
            onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            className="font-mono text-[11px] leading-relaxed"
          />
        </Field>
      </Card>

      <div className="sticky bottom-0 -mx-3 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-2xs text-amber-600">Unsaved changes</span>}
          <Button size="sm" disabled={!dirty} onClick={() => void savePrompt(draft)}>
            Save prompt
          </Button>
        </div>
      </div>
    </>
  )
}
