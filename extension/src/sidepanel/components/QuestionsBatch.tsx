/**
 * "Send N questions": the page's open written questions go to the answers chat in
 * one message, and the answers are typed into the form. Available on every page.
 */

import { useState } from 'react'
import { useAppState } from '../state/AppStateContext'
import { useWriting } from '../hooks/useWriting'
import { apiProviderId, chatSiteName, parseChatGptProjectUrl, usesApiKey, AICancelledError } from '@/ai'
import { answerInChat, writtenQuestions } from '../lib/batch-answers'
import { cancelTask, runExclusive, taskKey, useActivity } from '../lib/ai-activity'
import { ActivityLine } from './ResumeSection'
import { Button, Icon } from './ui'

const TASK = 'answers'

export function QuestionsBatch({ onOpenSettings }: { onOpenSettings: (tab: string) => void }) {
  const { session, preferences, perform, busy, highlightField } = useAppState()
  const writing = useWriting()
  const activity = useActivity(session ? taskKey(session.id, TASK) : null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  if (!session) return null

  const questions = writtenQuestions(session)
  const api = usesApiKey(preferences)
  const link = parseChatGptProjectUrl(preferences.chatgptAnswersUrl)
  const answerer = api ? (apiProviderId(preferences) === 'openai-api' ? 'OpenAI' : 'Gemini') : link ? chatSiteName(link) : ''
  if (!questions.length && !activity && !result) return null

  const send = () =>
    perform('answers:send', async () => {
      setResult(null)
      try {
        const outcome = await runExclusive(taskKey(session.id, TASK), 'Sending the questions...', (report, signal) =>
          answerInChat(session, preferences, questions, writing.update, { signal, report }),
        )
        const notes = [
          outcome.unanswered.length ? `no answer for: ${outcome.unanswered.join('; ')}` : '',
          outcome.failed.length ? `could not type into: ${outcome.failed.join('; ')}` : '',
          outcome.needsFact.length ? `needs a fact from you (not typed): ${outcome.needsFact.join('; ')}` : '',
        ].filter(Boolean)
        setResult({
          ok: !notes.length,
          text: `Filled ${outcome.filled} of ${questions.length}.${notes.length ? ` ${notes.join('. ')}.` : ' Check them before submitting.'}`,
        })
      } catch (error) {
        if (error instanceof AICancelledError) return
        throw error
      }
    })

  return (
    <div className="space-y-1.5 rounded-lg border border-brand-200 bg-brand-50/50 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-800">
          {questions.length
            ? `${questions.length} written question${questions.length === 1 ? '' : 's'} on this page`
            : 'Written questions'}
        </p>
        {answerer && <span className="text-2xs text-slate-500">{api ? answerer : `${answerer} chat`}</span>}
      </div>

      {questions.length > 0 && (
        <ol className="list-decimal space-y-0.5 pl-4">
          {questions.map((field) => (
            <li key={field.id} className="text-2xs text-slate-600">
              <button onClick={() => void highlightField(field.id)} className="text-left hover:text-brand-700" title="Show on the page">
                {field.label}
              </button>
            </li>
          ))}
        </ol>
      )}

      {activity ? (
        <ActivityLine message={activity} onCancel={() => cancelTask(taskKey(session.id, TASK))} />
      ) : !api && !link ? (
        <button onClick={() => onOpenSettings('ai')} className="flex items-center gap-1.5 text-2xs font-medium text-amber-800">
          <Icon name="alert" className="h-3 w-3" />
          Paste your answers chat link (ChatGPT or Claude), or add an API key, in Settings &gt; AI
        </button>
      ) : (
        questions.length > 0 && (
          <Button className="w-full" size="sm" loading={busy === 'answers:send'} onClick={() => void send()}>
            <Icon name="sparkle" className="h-3 w-3" />
            Answer {questions.length === 1 ? 'it' : `all ${questions.length}`} {api ? 'with' : 'in'} {answerer}
          </Button>
        )
      )}

      {result && <p className={result.ok ? 'text-2xs text-emerald-700' : 'text-2xs text-amber-800'}>{result.text}</p>}
    </div>
  )
}
