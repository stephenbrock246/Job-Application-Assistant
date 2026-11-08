/**
 * "The chat writes the text, the extension makes the files."
 *
 *   job -> the user's tailoring chat (it knows their CV) -> JSON with the headline,
 *   summary, skills, each position's title + bullets, and the cover letter ->
 *   placed into the master resume (layout, companies, places, dates untouched) ->
 *   fact-checked against the master -> .docx + PDF, and the cover letter PDF.
 *
 * Both files are saved to the job folder and used straight away (Settings > AI >
 * "Use the tailored CV and cover letter right away"); what the fact check flags
 * stays on them and is shown when the user approves the submit. With that setting
 * off they wait in the Resume / Cover letter sections for review first.
 */

import { ChatGptProjectProvider, chatSiteName, parseChatGptProjectUrl } from '@/ai/chatgpt-project.provider'
import { throwIfCancelled } from '@/ai/retry'
import { analyzeResume, contentEdits } from '@/resume/sections'
import { contentMessage, parseContent } from '@/resume/chat-content'
import { checkFacts } from '@/resume/fact-check'
import { withLetterChecks } from '@/resume/cover-letter'
import { requireJobDescription, requireMaster } from '@/resume/resume-tailor'
import { masterParagraphs } from '@/resume/resume-parser'
import { getSession } from '@/storage/sessions'
import { approveAndSaveResume, requireJobNames, saveLetterPdf } from './writing-actions'
import type { ApplicationSession } from '@/shared/types/application'
import type { WritingPatch } from '@/shared/types/messages'
import type { Preferences } from '@/shared/types/settings'

export interface ChatTailorResult {
  resumeWarnings: number
  resumeApproved: boolean
  letter: 'none' | 'approved' | 'review'
}

export async function tailorWithChatContent(
  session: ApplicationSession,
  prefs: Preferences,
  update: (patch: WritingPatch) => Promise<void>,
  options: { signal?: AbortSignal; report?: (message: string) => void } = {},
): Promise<ChatTailorResult> {
  requireJobNames(session)
  const master = await requireMaster()
  const description = requireJobDescription(session)
  const layout = analyzeResume(masterParagraphs(master))
  if (!layout.summary && !layout.skills && !layout.experience) {
    throw new Error(
      'Could not find the Summary, Skills or Experience sections in your master resume. Check that their headings are on their own lines.',
    )
  }

  const link = parseChatGptProjectUrl(prefs.chatgptProjectUrl)
  const site = link ? chatSiteName(link) : 'The chat'
  const chat = new ChatGptProjectProvider('tailor')
  const ask = { ...(options.signal ? { signal: options.signal } : {}) }
  options.report?.(`${site} is tailoring your CV...`)
  const reply = await chat.complete(contentMessage(layout, { company: session.company, position: session.position, description }), ask)
  throwIfCancelled(options.signal)

  // A chat set up to make files may answer with a file instead; ask once for the text.
  let content
  try {
    content = parseContent(reply)
  } catch {
    options.report?.(`${site} did not send the text - asking once more...`)
    const again = await chat.complete(ASK_FOR_JSON_AGAIN, ask)
    throwIfCancelled(options.signal)
    content = parseContent(again)
  }
  const { edits, notes } = contentEdits(layout, content)
  if (!edits.length) throw new Error(`${site} replied, but nothing in it changes your CV. Press Tailor again.`)

  const context = { source: master.text, jobDescription: description }
  const warnings = edits.flatMap((edit) => (edit.removed ? [] : checkFacts(edit.text, context, edit.id)))
  options.report?.('Building your CV...')
  await update({
    resume: {
      promptProfileId: 'chat-content',
      promptProfileName: `Your ${site} chat`,
      generatedBy: { model: site, fallback: false },
      edits,
      changeNotes: notes,
      warnings,
      masterFileName: master.fileName,
      masterUploadedAt: master.uploadedAt,
      generatedAt: Date.now(),
      approved: false,
    },
    resumeApproved: false,
    tailoredResume: null,
    // A resume uploaded for an earlier version must be uploaded again.
    autopilot: { ...(session.autopilot ?? {}), attached: {} },
  })

  const result: ChatTailorResult = { resumeWarnings: warnings.length, resumeApproved: false, letter: 'none' }
  let letter = content.coverLetter
    ? await withLetterChecks(session, { text: content.coverLetter, warnings: [], generatedAt: Date.now(), approved: false })
    : null
  if (letter) {
    letter = { ...letter, generatedBy: { model: site, fallback: false } }
    await update({ coverLetter: letter })
    result.letter = 'review'
  }

  // The files are made and used at once; anything the fact check found is listed
  // for the user to look at when they approve the submit. (Setting off: wait for review first.)
  if (prefs.autoApproveClean) {
    const fresh = (await getSession(session.id)) ?? session
    await approveAndSaveResume(fresh, master, update)
    result.resumeApproved = true
    if (letter) {
      await update({ coverLetter: { ...letter, approved: true } })
      await saveLetterPdf(fresh, letter.text)
      result.letter = 'approved'
    }
  }
  return result
}

const ASK_FOR_JSON_AGAIN =
  'Please reply again with only the JSON code block I asked for (headline, summary, skills, experience, coverLetter) - as text, no files or download links.'
