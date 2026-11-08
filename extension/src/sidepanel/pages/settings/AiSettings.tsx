/**
 * AI settings. Two ways to run the AI:
 *  - chat: the user's own ChatGPT / Claude chats on their login - tailoring in one
 *    chat, written answers and cover letters in another. No key.
 *  - api:  an API key - Google Gemini (free tier) or OpenAI. Tailors the master
 *    resume, writes cover letters and answers; everything is fact-checked.
 */

import { useEffect, useState } from 'react'
import { useAppState } from '../../state/AppStateContext'
import {
  GEMINI_MODELS,
  OPENAI_MODELS,
  apiProviderId,
  chatSiteName,
  checkChatGptLink,
  getProvider,
  isChatLink,
  isProjectLink,
  parseChatGptProjectUrl,
  usesApiKey,
} from '@/ai'
import { clearApiKey, getApiKey, isApiKeyRemembered, setApiKey, type CredentialName } from '@/storage/credentials'
import { Badge, Button, Card, Field, Select, TextInput, Toggle, cx } from '../../components/ui'
import type { Preferences } from '@/shared/types/settings'

export function AiSettings() {
  const { preferences, setPreference } = useAppState()
  const api = usesApiKey(preferences)

  return (
    <div className="space-y-3">
      <EngineCard />
      {api ? <ApiKeyCard /> : (
        <>
          <TailoringCard />
          <AnswersCard />
        </>
      )}

      <Card className="p-3">
        <h2 className="text-[13px] font-semibold text-slate-900">Automation</h2>
        <Toggle
          label="Add my CV and cover letter to the form automatically"
          hint="Uploads them to the form's upload fields and pastes the cover letter into its text box, once per page."
          checked={preferences.autoAttachFiles}
          onChange={(value) => void setPreference('autoAttachFiles', value)}
        />
        {api && (
          <Toggle
            label="Write a cover letter when the form asks for one"
            checked={preferences.autoCoverLetter}
            onChange={(value) => void setPreference('autoCoverLetter', value)}
          />
        )}
        <Toggle
          label="Use the tailored CV and cover letter right away"
          hint="They are saved to the job folder and added to the form at once. Anything the fact check finds is listed when you approve the submit. Off: Autopilot waits for you to approve them first."
          checked={preferences.autoApproveClean}
          onChange={(value) => void setPreference('autoApproveClean', value)}
        />
      </Card>

      <p className="px-1 text-2xs leading-relaxed text-slate-400">
        {api
          ? 'Your master resume (Settings > Resume) and profile are sent with each request, so the answers are about you. Nothing is stated that is not in them.'
          : 'Stay logged in to chatgpt.com / claude.ai in this Chrome window. The extension types into those tabs and reads the replies; one request runs at a time.'}
      </p>
    </div>
  )
}

/** Chats on the user's login, or an API key. */
function EngineCard() {
  const { preferences, setPreference, refreshAiStatus } = useAppState()
  const choose = async (mode: Preferences['aiMode']) => {
    await setPreference('aiMode', mode)
    await refreshAiStatus()
  }
  const options: { mode: Preferences['aiMode']; title: string; detail: string }[] = [
    { mode: 'api', title: 'API key', detail: 'Google Gemini (free) or OpenAI. Fastest and most reliable.' },
    { mode: 'chat', title: 'My ChatGPT / Claude chats', detail: 'Uses your logged-in chats. No key needed.' },
  ]
  return (
    <Card className="p-3">
      <h2 className="mb-2 text-[13px] font-semibold text-slate-900">How the AI runs</h2>
      <div className="grid grid-cols-2 gap-1.5">
        {options.map((option) => (
          <button
            key={option.mode}
            onClick={() => void choose(option.mode)}
            className={cx(
              'rounded-lg border px-2.5 py-2 text-left transition-colors',
              preferences.aiMode === option.mode ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50',
            )}
          >
            <p className="text-xs font-semibold text-slate-800">{option.title}</p>
            <p className="mt-0.5 text-2xs leading-snug text-slate-500">{option.detail}</p>
          </button>
        ))}
      </div>
    </Card>
  )
}

const KEY_HELP: Record<'gemini-api' | 'openai-api', { name: string; url: string; steps: string }> = {
  'gemini-api': {
    name: 'Gemini',
    url: 'https://aistudio.google.com/apikey',
    steps: 'Free: sign in to Google AI Studio, press "Create API key", copy it here. No card needed. The free tier has daily limits.',
  },
  'openai-api': {
    name: 'OpenAI',
    url: 'https://platform.openai.com/api-keys',
    steps: 'Paid per use (separate from a ChatGPT subscription): create a key on the OpenAI platform and copy it here.',
  },
}

function ApiKeyCard() {
  const { preferences, setPreference, refreshAiStatus } = useAppState()
  const provider = apiProviderId(preferences)
  const credential: CredentialName = provider === 'openai-api' ? 'openai' : 'gemini'
  const help = KEY_HELP[provider]

  const [stored, setStored] = useState<{ has: boolean; remembered: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [remember, setRemember] = useState(true)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const reload = async () => {
    const [key, remembered] = await Promise.all([getApiKey(credential), isApiKeyRemembered(credential)])
    setStored({ has: Boolean(key), remembered })
    if (key) setRemember(remembered)
  }
  useEffect(() => {
    setStatus(null)
    setDraft('')
    void reload()
  }, [credential])

  const save = async () => {
    await setApiKey(credential, draft, remember)
    setDraft('')
    await reload()
    await refreshAiStatus()
    setStatus({ ok: true, text: 'Saved. Press Test to check it.' })
  }

  const remove = async () => {
    await clearApiKey(credential)
    await reload()
    await refreshAiStatus()
    setStatus(null)
  }

  const test = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const reply = await getProvider(provider).complete!('Reply with the single word OK.')
      setStatus({ ok: true, text: `Works - ${help.name} replied "${reply.trim().slice(0, 40)}".` })
    } catch (error) {
      setStatus({ ok: false, text: error instanceof Error ? error.message : 'The test failed.' })
    } finally {
      setTesting(false)
    }
  }

  const models = provider === 'openai-api' ? OPENAI_MODELS : GEMINI_MODELS
  const modelKey = provider === 'openai-api' ? 'openaiModel' : 'geminiModel'

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">API key</h2>
        <Badge tone={stored?.has ? 'green' : 'amber'}>{stored?.has ? `${help.name} - key saved` : 'No key'}</Badge>
      </div>

      <div className="mt-2 space-y-2">
        <Field label="Provider">
          <Select value={provider} onChange={(event) => void setPreference('aiProviderId', event.target.value as Preferences['aiProviderId']).then(refreshAiStatus)}>
            <option value="gemini-api">Google Gemini - free tier</option>
            <option value="openai-api">OpenAI - paid per use</option>
          </Select>
        </Field>

        <p className="text-2xs leading-relaxed text-slate-500">
          {help.steps}{' '}
          <a href={help.url} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:text-brand-700">
            Get a key
          </a>
        </p>

        <Field label={stored?.has ? 'Replace the key' : `${help.name} API key`}>
          <div className="flex gap-1.5">
            <TextInput
              type="password"
              autoComplete="off"
              value={draft}
              placeholder={stored?.has ? '••••••••  (saved)' : 'Paste your key'}
              onChange={(event) => setDraft(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button size="sm" disabled={!draft.trim()} onClick={() => void save()}>
              Save
            </Button>
          </div>
        </Field>
        <Toggle
          label="Remember on this computer"
          hint="Needed for Autopilot after Chrome restarts. Stored in this Chrome profile, not encrypted. Off: forgotten when Chrome closes."
          checked={remember}
          onChange={(value) => {
            setRemember(value)
            // Applies to the saved key at once.
            if (stored?.has) {
              void getApiKey(credential)
                .then(async (key) => {
                  if (key) await setApiKey(credential, key, value)
                })
                .then(reload)
            }
          }}
        />

        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={!stored?.has} loading={testing} onClick={() => void test()}>
            Test
          </Button>
          {stored?.has && (
            <Button size="sm" variant="ghost" onClick={() => void remove()}>
              Remove key
            </Button>
          )}
        </div>
        {status && <p className={cx('text-2xs', status.ok ? 'text-emerald-700' : 'text-red-700')}>{status.text}</p>}

        <Field label="Model">
          <Select value={preferences[modelKey]} onChange={(event) => void setPreference(modelKey, event.target.value)}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </Select>
        </Field>

        {provider === 'gemini-api' && (
          <Toggle
            label="Hide my email, phone and links from Google"
            hint="On the free tier Google may use what is sent to improve its products. They are put back in the reply."
            checked={preferences.redactContacts}
            onChange={(value) => void setPreference('redactContacts', value)}
          />
        )}
      </div>
    </Card>
  )
}

/** Tailoring in the user's own ChatGPT chat: it gets the job and creates the CV and cover letter. */
function TailoringCard() {
  const { preferences, setPreference } = useAppState()
  const saved = parseChatGptProjectUrl(preferences.chatgptProjectUrl)
  const on = preferences.tailorVia === 'chatgpt-project' && Boolean(saved)

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">Tailoring chat</h2>
        <Badge tone={on ? 'green' : 'amber'}>{on && saved ? `${chatSiteName(saved)} - connected` : 'Not set'}</Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        Tailor sends the job to this chat. It writes the CV and cover letter for the job; they are saved to the job
        folder and added to the form.
      </p>
      <div className="mt-2 space-y-2">
        <LinkField
          prefKey="chatgptProjectUrl"
          label="Chat link (ChatGPT or Claude)"
          hint="Open the chat and copy the address bar. Not a Share link."
          onSaved={async () => {
            // Saving a link means using it.
            await setPreference('tailorVia', 'chatgpt-project')
          }}
        />
        {saved && (
          <Field label="What the chat sends back">
            <Select
              value={preferences.tailorOutput}
              onChange={(event) => void setPreference('tailorOutput', event.target.value as Preferences['tailorOutput'])}
            >
              <option value="content">Tailored text - the extension makes the PDFs (recommended)</option>
              <option value="file">Finished PDF files made by the chat</option>
            </Select>
          </Field>
        )}
        {saved && preferences.tailorOutput === 'content' && (
          <p className="text-2xs leading-relaxed text-slate-500">
            The chat writes the headline, summary, skills, and each position&apos;s title and bullets, plus the cover
            letter. They go into your master resume (Settings &gt; Resume) - its layout, companies, locations and
            dates stay as they are. Everything is checked against your master resume before it is used.
          </p>
        )}
        {saved && preferences.tailorOutput === 'file' && <MessageField />}
        {saved && (
          <Toggle
            label="Use this chat for tailoring"
            checked={on}
            onChange={(value) => void setPreference('tailorVia', value ? 'chatgpt-project' : 'provider')}
          />
        )}
      </div>
    </Card>
  )
}

/** The one chat that answers the form's written questions. */
function AnswersCard() {
  const { preferences, setPreference } = useAppState()
  const saved = parseChatGptProjectUrl(preferences.chatgptAnswersUrl)
  const [message, setMessage] = useState(preferences.chatgptAnswersMessage)
  useEffect(() => setMessage(preferences.chatgptAnswersMessage), [preferences.chatgptAnswersMessage])

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-slate-900">Answers chat</h2>
        <Badge tone={saved ? 'green' : 'amber'}>{saved ? `${chatSiteName(saved)} - connected` : 'Not set'}</Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-600">
        The form&apos;s open written questions are sent here in one message - questions only, no CV or job description
        - and each answer is typed into its box. Tell this chat about yourself once; it answers from that.
      </p>
      <div className="mt-2 space-y-2">
        <LinkField
          prefKey="chatgptAnswersUrl"
          label="Chat link (ChatGPT or Claude)"
          hint="One chat for all answers. Copy its address bar - not a Share link, and not your tailoring chat."
        />
        <Field label="Message sent with the questions" hint="{company} and {position} are filled in. Keep the [1] [2] reply format.">
          <TextInput
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onBlur={() => message !== preferences.chatgptAnswersMessage && void setPreference('chatgptAnswersMessage', message)}
          />
        </Field>
      </div>
    </Card>
  )
}

function LinkField({
  prefKey,
  label,
  hint,
  allowClear = false,
  onSaved,
}: {
  prefKey: 'chatgptProjectUrl' | 'chatgptAnswersUrl'
  label: string
  hint: string
  allowClear?: boolean
  onSaved?: () => Promise<void>
}) {
  const { preferences, setPreference } = useAppState()
  const current = preferences[prefKey] as Preferences[typeof prefKey]
  const [draft, setDraft] = useState(current)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(current), [current])

  const save = async () => {
    if (allowClear && !draft.trim()) {
      setError(null)
      await setPreference(prefKey, '')
      return
    }
    const checked = checkChatGptLink(draft)
    if (!checked.url) {
      setError(checked.error ?? 'Paste a https://chatgpt.com/... link.')
      return
    }
    setError(null)
    await setPreference(prefKey, checked.url)
    await onSaved?.()
  }

  const saved = parseChatGptProjectUrl(current)
  return (
    <div className="space-y-1">
      <Field label={label} hint={hint}>
        <div className="flex gap-1.5">
          <TextInput
            value={draft}
            placeholder="https://chatgpt.com/g/g-p-.../c/..."
            onChange={(event) => setDraft(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={draft.trim() === current || (!allowClear && !draft.trim())}
          >
            Save
          </Button>
        </div>
      </Field>
      {error && <p className="text-2xs text-red-700">{error}</p>}
      {saved && !isChatLink(saved) && !isProjectLink(saved) && (
        <p className="text-2xs text-amber-800">Not a chat link: each request would start a blank chat.</p>
      )}
    </div>
  )
}

/** The line sent above the job description. */
function MessageField() {
  const { preferences, setPreference } = useAppState()
  const [value, setValue] = useState(preferences.chatgptMessage)
  useEffect(() => setValue(preferences.chatgptMessage), [preferences.chatgptMessage])
  return (
    <Field label="Message sent with the job" hint="Followed by the company, position and job description.">
      <TextInput
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value !== preferences.chatgptMessage && void setPreference('chatgptMessage', value)}
      />
    </Field>
  )
}
