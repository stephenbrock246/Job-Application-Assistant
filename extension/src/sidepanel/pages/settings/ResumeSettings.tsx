import { useMemo, useRef, useState } from 'react'
import { useStorageSlot } from '../../hooks/useStorageSlot'
import { masterResumeSlot } from '@/storage/settings'
import { extractResume, masterParagraphs } from '@/resume/resume-parser'
import { extractProfile, mergeSuggestions } from '@/resume/profile-extract'
import { profileSlot, saveProfile } from '@/storage/applicant-profile'
import { coverLetterFileName, resumeFileName } from '@/shared/utils/format'
import { EMPTY_PROFILE } from '@/shared/constants/defaults'
import { Badge, Button, Card, Field, Icon, TextArea } from '../../components/ui'
import type { MasterResumeMeta } from '@/shared/types/settings'
import type { ResumeParagraph } from '@/shared/types/resume'

/**
 * Copies what the resume states into *empty* profile fields and returns their labels.
 * A value the user already entered is never replaced here - that needs their review
 * on the Profile screen.
 */
async function fillEmptyProfileFields(meta: MasterResumeMeta): Promise<string[]> {
  const suggestions = extractProfile(masterParagraphs(meta))
  const { profile, applied } = mergeSuggestions(await profileSlot.get(), suggestions, true)
  if (applied.length) await saveProfile(profile)
  return applied.map((s) => s.label)
}

export function ResumeSettings({ onOpenProfile }: { onOpenProfile: () => void }) {
  const [resume, setResume] = useStorageSlot(masterResumeSlot, null as MasterResumeMeta | null)
  const [profile] = useStorageSlot(profileSlot, EMPTY_PROFILE)
  const { personal } = profile
  const ownerName = personal.fullName.trim() || [personal.firstName, personal.lastName].filter(Boolean).join(' ') || 'Your Name'
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [filled, setFilled] = useState<string[] | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const isDocx = resume?.format === 'docx' && Boolean(resume.docxBase64)

  const paragraphs = useMemo<ResumeParagraph[]>(() => {
    if (!resume) return []
    try {
      return masterParagraphs(resume)
    } catch {
      return []
    }
  }, [resume])

  const onFile = async (file: File) => {
    setBusy(true)
    setNote(null)
    try {
      const extracted = await extractResume(file)
      await setResume(extracted.meta)
      setText(null)
      setNote(extracted.note)
      setFilled(await fillEmptyProfileFields(extracted.meta))
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  const currentText = text ?? resume?.text ?? ''

  return (
    <div className="space-y-3">
      <Card className="space-y-2.5 p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Master resume</h2>
        <p className="text-xs leading-relaxed text-slate-600">
          The factual source for every tailored resume, cover letter and drafted answer. Upload the
          <span className="font-medium"> .docx</span> to have tailored resumes keep your exact Word
          layout - only paragraph text is changed.
        </p>

        {resume ? (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2">
            <Icon name="file" className="h-4 w-4 shrink-0 text-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-800">{resume.fileName}</p>
              <p className="text-2xs text-slate-500">
                {(resume.sizeBytes / 1024).toFixed(0)} KB &middot; {paragraphs.length} paragraphs
              </p>
            </div>
            {isDocx ? (
              <Badge tone="green">Layout preserved</Badge>
            ) : (
              <Badge tone="amber">{resume.textIsApproximate ? 'Check text' : 'Text only'}</Badge>
            )}
          </div>
        ) : null}

        <input
          ref={fileInput}
          type="file"
          accept=".docx,.txt,.md,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void onFile(file)
            event.target.value = ''
          }}
        />

        <Button variant="secondary" size="sm" loading={busy} onClick={() => fileInput.current?.click()}>
          {resume ? 'Replace file' : 'Upload master resume'}
        </Button>

        {note && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-2xs leading-relaxed text-amber-800">
            {note}
          </p>
        )}

        {filled && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-2 text-2xs leading-relaxed text-emerald-800">
            {filled.length ? (
              <>
                Filled {filled.length} empty profile field{filled.length === 1 ? '' : 's'} from this resume:{' '}
                {filled.join(', ')}. Fields you had already filled were left as they were.
              </>
            ) : (
              <>Your profile already has everything this resume states.</>
            )}{' '}
            <button onClick={onOpenProfile} className="font-medium underline underline-offset-2">
              Review profile
            </button>
          </div>
        )}
      </Card>

      {resume && isDocx && (
        <Card className="space-y-2 p-3">
          <h2 className="text-[13px] font-semibold text-slate-900">What the AI sees</h2>
          <p className="text-xs leading-relaxed text-slate-600">
            Each paragraph of your document, numbered. Tailoring may rewrite or remove these, never add
            new ones. To change the source text, edit the .docx and upload it again.
          </p>
          <ol className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
            {paragraphs.map((p) => (
              <li key={p.id} className="flex gap-1.5 text-2xs leading-relaxed">
                <span className="w-7 shrink-0 font-mono text-slate-400">P{p.id}</span>
                <span className={p.role === 'heading' || p.role === 'title' ? 'font-semibold text-slate-800' : 'text-slate-600'}>
                  {p.role === 'bullet' ? '• ' : ''}
                  {p.text.replace(/\t/g, '  ')}
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {(!resume || !isDocx) && (
        <Card className="space-y-2.5 p-3">
          <h2 className="text-[13px] font-semibold text-slate-900">Resume text</h2>
          <p className="text-xs leading-relaxed text-slate-600">
            Exactly what gets sent for tailoring. One paragraph per line; start bullet lines with "- ".
          </p>

          <Field label="Plain text">
            <TextArea
              rows={14}
              value={currentText}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste your resume text here"
              className="font-mono text-[11px] leading-relaxed"
            />
          </Field>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={text === null || text === resume?.text}
              onClick={() =>
                void setResume({
                  fileName: resume?.fileName ?? 'Master_Resume.txt',
                  mimeType: resume?.mimeType ?? 'text/plain',
                  sizeBytes: new Blob([currentText]).size,
                  uploadedAt: Date.now(),
                  text: currentText,
                  textIsApproximate: false,
                  format: 'text',
                })
              }
            >
              Save resume text
            </Button>
          </div>
        </Card>
      )}

      <Card className="space-y-2 p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Output</h2>
        <p className="text-xs text-slate-600">
          One folder per application, named after the job - e.g. Downloads/JobApply/Accesa_Technical_Lead_with_React/ -
          holding (named after you, as recruiters see them):
        </p>
        <code className="block space-y-0.5 rounded bg-slate-50 px-2 py-1.5 text-2xs text-slate-700">
          {isDocx && <span className="block">{resumeFileName(ownerName, 'docx')}</span>}
          <span className="block">{resumeFileName(ownerName, 'pdf')}</span>
          <span className="block">{coverLetterFileName(ownerName)}</span>
        </code>
        <p className="text-2xs leading-relaxed text-slate-400">
          {isDocx
            ? 'The .docx is your document with the tailored text. The PDF uses a simple layout - export the .docx to PDF from Word when a site needs an exact PDF.'
            : 'Text-only master: output is PDF in a simple layout.'}
        </p>
      </Card>
    </div>
  )
}
