import { useEffect, useMemo, useState } from 'react'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { profileCompleteness, profileSlot, saveProfile } from '@/storage/applicant-profile'
import { masterResumeSlot } from '@/storage/settings'
import { masterParagraphs } from '@/resume/resume-parser'
import { extractProfile, mergeSuggestions, type ProfileSuggestion } from '@/resume/profile-extract'
import { EMPTY_PROFILE } from '@/shared/constants/defaults'
import { Button, Card, Field, Icon, PhaseNotice, Select, TextArea, TextInput } from '../../components/ui'
import type { ApplicantProfile } from '@/shared/types/profile'
import type { MasterResumeMeta } from '@/shared/types/settings'

type Section = keyof Omit<ApplicantProfile, 'updatedAt'>

interface FieldDef {
  section: Section
  name: string
  label: string
  type?: 'text' | 'textarea' | 'select'
  options?: { value: string; label: string }[]
  placeholder?: string
  hint?: string
}

const GROUPS: { title: string; note?: string; fields: FieldDef[] }[] = [
  {
    title: 'Personal information',
    fields: [
      { section: 'personal', name: 'firstName', label: 'First name' },
      { section: 'personal', name: 'middleName', label: 'Middle name' },
      { section: 'personal', name: 'lastName', label: 'Last name' },
      { section: 'personal', name: 'fullName', label: 'Full name', hint: 'Leave blank to use first + last' },
      { section: 'personal', name: 'email', label: 'Email', placeholder: 'you@example.com' },
      { section: 'personal', name: 'phone', label: 'Phone', placeholder: '+1 (415) 555-0123' },
      { section: 'personal', name: 'address', label: 'Address' },
      { section: 'personal', name: 'city', label: 'City' },
      { section: 'personal', name: 'state', label: 'State / Province' },
      { section: 'personal', name: 'zip', label: 'ZIP / Postcode' },
      { section: 'personal', name: 'country', label: 'Country' },
      { section: 'personal', name: 'linkedin', label: 'LinkedIn', placeholder: 'https://linkedin.com/in/...' },
      { section: 'personal', name: 'github', label: 'GitHub', placeholder: 'https://github.com/...' },
      { section: 'personal', name: 'portfolio', label: 'Portfolio / Website' },
    ],
  },
  {
    title: 'Professional information',
    fields: [
      { section: 'professional', name: 'currentTitle', label: 'Current job title' },
      { section: 'professional', name: 'currentCompany', label: 'Current company' },
      { section: 'professional', name: 'yearsOfExperience', label: 'Years of experience', placeholder: '5' },
      {
        section: 'professional',
        name: 'primarySkills',
        label: 'Primary skills',
        type: 'textarea',
        placeholder: 'TypeScript, React, Node.js, PostgreSQL',
      },
      {
        section: 'professional',
        name: 'education',
        label: 'Education',
        type: 'textarea',
        placeholder: 'BSc Computer Science, University of ...',
      },
    ],
  },
  {
    title: 'Job preferences',
    fields: [
      { section: 'preferences', name: 'expectedSalary', label: 'Expected salary', placeholder: '12,000 - 15,000' },
      { section: 'preferences', name: 'salaryCurrency', label: 'Currency', placeholder: 'USD' },
      {
        section: 'preferences',
        name: 'salaryPeriod',
        label: 'Salary period',
        type: 'select',
        options: [
          { value: 'yearly', label: 'Per year' },
          { value: 'monthly', label: 'Per month' },
          { value: 'hourly', label: 'Per hour' },
        ],
      },
      { section: 'preferences', name: 'preferredLocation', label: 'Preferred location' },
      {
        section: 'preferences',
        name: 'remotePreference',
        label: 'Remote preference',
        type: 'select',
        options: [
          { value: '', label: 'Not specified' },
          { value: 'remote', label: 'Remote' },
          { value: 'hybrid', label: 'Hybrid' },
          { value: 'onsite', label: 'On-site' },
          { value: 'flexible', label: 'Flexible' },
        ],
      },
      {
        section: 'preferences',
        name: 'relocationPreference',
        label: 'Relocation',
        type: 'select',
        options: [
          { value: '', label: 'Not specified' },
          { value: 'yes', label: 'Willing to relocate' },
          { value: 'no', label: 'Not willing to relocate' },
          { value: 'negotiable', label: 'Negotiable' },
        ],
      },
      { section: 'preferences', name: 'noticePeriod', label: 'Notice period', placeholder: '2 weeks' },
      { section: 'preferences', name: 'availableStartDate', label: 'Available start date' },
    ],
  },
  {
    title: 'Work authorization',
    note: 'These are filled only when a form asks a question that clearly maps to them.',
    fields: [
      {
        section: 'workAuthorization',
        name: 'workAuthorization',
        label: 'Work authorization',
        placeholder: 'I am authorized to work in the U.S.',
      },
      {
        section: 'workAuthorization',
        name: 'sponsorshipRequired',
        label: 'Sponsorship requirement',
        placeholder: 'No sponsorship required',
      },
    ],
  },
  {
    title: 'Voluntary self-identification (optional)',
    note:
      'Equal-opportunity questions (gender, race, veteran, disability). Leave blank and you always answer them yourself. Fill one in and that exact answer is chosen whenever a form offers it - e.g. "Decline to self-identify". Nothing is ever guessed.',
    fields: [
      { section: 'voluntary', name: 'gender', label: 'Gender', placeholder: 'e.g. Decline to self-identify' },
      {
        section: 'voluntary',
        name: 'raceEthnicity',
        label: 'Race / ethnicity',
        placeholder: 'e.g. Decline to self-identify',
      },
      {
        section: 'voluntary',
        name: 'veteranStatus',
        label: 'Veteran status',
        placeholder: 'e.g. I am not a protected veteran',
      },
      {
        section: 'voluntary',
        name: 'disabilityStatus',
        label: 'Disability status',
        placeholder: 'e.g. I do not wish to answer',
      },
    ],
  },
]

const keyOf = (s: ProfileSuggestion) => `${s.section}.${s.name}`

/**
 * "Fill from your resume": everything the master resume states that differs from
 * the profile form. Empty fields are pre-ticked; a value that would replace what
 * you typed is shown next to it and left unticked. Applying fills the form only -
 * nothing is saved until you press Save profile.
 */
function ResumeImportCard({
  draft,
  onApply,
}: {
  draft: ApplicantProfile
  onApply: (next: ApplicantProfile) => void
}) {
  const [master] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [appliedCount, setAppliedCount] = useState(0)

  const suggestions = useMemo(() => {
    if (!master) return []
    try {
      return extractProfile(masterParagraphs(master))
    } catch {
      return []
    }
  }, [master])

  const current = (s: ProfileSuggestion) =>
    ((draft[s.section] as unknown as Record<string, string>)[s.name] ?? '').trim()
  const rows = suggestions.filter((s) => current(s) !== s.value)
  const rowKeys = rows.map(keyOf).join('|')

  // Re-derive the default ticks only when the *set* of differences changes - not on
  // every keystroke in the form, which would undo the user's own ticking.
  useEffect(() => {
    setSelected(new Set(rows.filter((s) => !current(s)).map(keyOf)))
  }, [rowKeys])

  if (!master) {
    return (
      <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-slate-500">
        <Icon name="info" className="mt-px h-3 w-3 shrink-0" />
        Upload your resume in Settings &gt; Resume and these fields are filled from it.
      </p>
    )
  }

  if (!rows.length) {
    return appliedCount ? (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-2xs text-emerald-800">
        Filled {appliedCount} field{appliedCount === 1 ? '' : 's'} from your resume - press Save profile to keep
        them.
      </p>
    ) : suggestions.length ? (
      <p className="flex items-center gap-1.5 text-2xs text-emerald-700">
        <Icon name="check" className="h-3 w-3" />
        Everything {master.fileName} states is already in your profile.
      </p>
    ) : null
  }

  const toggle = (key: string) =>
    setSelected((currentSet) => {
      const next = new Set(currentSet)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <Card className="space-y-2 p-3">
      <div>
        <h2 className="text-[13px] font-semibold text-slate-900">Fill from your resume</h2>
        <p className="mt-0.5 text-2xs leading-relaxed text-slate-500">
          Read from {master.fileName}. Only what the resume states - nothing is guessed. Hover a value to see
          the line it came from.
        </p>
      </div>

      <ul className="space-y-1">
        {rows.map((s) => {
          const key = keyOf(s)
          const existing = current(s)
          return (
            <li key={key}>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => toggle(key)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-2xs text-slate-500">{s.label}</span>
                  <span className="block break-words text-xs text-slate-800" title={`From: ${s.source}`}>
                    {s.value}
                  </span>
                  {existing && (
                    <span className="block break-words text-2xs text-amber-700">Replaces: {existing}</span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={!selected.size}
          onClick={() => {
            const chosen = rows.filter((s) => selected.has(keyOf(s)))
            const { profile, applied } = mergeSuggestions(draft, chosen, false)
            setAppliedCount(applied.length)
            onApply(profile)
          }}
        >
          Fill {selected.size} field{selected.size === 1 ? '' : 's'}
        </Button>
        <button
          onClick={() => setSelected(new Set(rows.map(keyOf)))}
          className="text-2xs font-medium text-brand-600 hover:text-brand-700"
        >
          Select all
        </button>
      </div>
    </Card>
  )
}

export function ProfileSettings() {
  const [stored, , loaded] = useStorageSlot(profileSlot, EMPTY_PROFILE)
  const [draft, setDraft] = useState<ApplicantProfile>(EMPTY_PROFILE)
  const [saved, setSaved] = useState(false)

  // Adopt storage as the draft until the user starts editing.
  useEffect(() => {
    if (loaded) setDraft(stored)
  }, [loaded, stored])

  const dirty = useMemo(
    () => JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...stored, updatedAt: 0 }),
    [draft, stored],
  )

  const completeness = profileCompleteness(draft)

  const setValue = (section: Section, name: string, value: string) => {
    setSaved(false)
    setDraft((current) => ({
      ...current,
      [section]: { ...current[section], [name]: value },
    }))
  }

  const onSave = async () => {
    const next = { ...draft }
    // A sensible derived default, not a guess about the user.
    if (!next.personal.fullName.trim()) {
      next.personal.fullName = [next.personal.firstName, next.personal.lastName]
        .filter(Boolean)
        .join(' ')
    }
    await saveProfile(next)
    setDraft(next)
    setSaved(true)
  }

  return (
    <div className="space-y-3 pb-16">
      <PhaseNotice phase="Never guessed.">
        Blank fields stay blank. When a form asks for something that is not saved here, the extension
        asks you instead of inventing an answer.
      </PhaseNotice>

      <ResumeImportCard
        draft={draft}
        onApply={(next) => {
          setSaved(false)
          setDraft(next)
        }}
      />

      {GROUPS.map((group) => (
        <Card key={group.title} className="p-3">
          <h2 className="mb-0.5 text-[13px] font-semibold text-slate-900">{group.title}</h2>
          {group.note && <p className="mb-2 text-2xs leading-relaxed text-slate-500">{group.note}</p>}

          <div className="mt-2 space-y-2.5">
            {group.fields.map((field) => {
              const value =
                (draft[field.section] as unknown as Record<string, string>)[field.name] ?? ''
              return (
                <Field key={`${field.section}.${field.name}`} label={field.label} hint={field.hint}>
                  {field.type === 'textarea' ? (
                    <TextArea
                      rows={2}
                      value={value}
                      placeholder={field.placeholder}
                      onChange={(event) => setValue(field.section, field.name, event.target.value)}
                    />
                  ) : field.type === 'select' ? (
                    <Select
                      value={value}
                      onChange={(event) => setValue(field.section, field.name, event.target.value)}
                    >
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <TextInput
                      value={value}
                      placeholder={field.placeholder}
                      onChange={(event) => setValue(field.section, field.name, event.target.value)}
                    />
                  )}
                </Field>
              )
            })}
          </div>
        </Card>
      ))}

      <div className="sticky bottom-0 -mx-3 border-t border-slate-200 bg-white/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <span className="flex-1 text-2xs text-slate-500">
            {completeness.filled} of {completeness.total} fields filled
            {saved && !dirty && <span className="ml-1.5 text-emerald-600">- saved</span>}
          </span>
          <Button size="sm" onClick={() => void onSave()} disabled={!dirty}>
            Save profile
          </Button>
        </div>
      </div>
    </div>
  )
}
