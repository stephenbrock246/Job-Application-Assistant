import { ProfileSettings } from './settings/ProfileSettings'
import { SourceSettings } from './settings/SourceSettings'
import { AnswersSettings } from './settings/AnswersSettings'
import { ResumeSettings } from './settings/ResumeSettings'
import { AiSettings } from './settings/AiSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { Icon, cx } from '../components/ui'

export type SettingsTab = 'profile' | 'source' | 'answers' | 'resume' | 'ai' | 'general'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'answers', label: 'Answers' },
  { id: 'resume', label: 'Resume' },
  { id: 'ai', label: 'AI' },
  { id: 'source', label: 'Job source' },
  { id: 'general', label: 'General' },
]

export function SettingsPage({
  tab,
  onChangeTab,
  onClose,
}: {
  tab: SettingsTab
  onChangeTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  return (
    <div className="flex h-full flex-col bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="flex items-center gap-2 px-2 py-2.5">
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            aria-label="Back"
          >
            <Icon name="back" />
          </button>
          <h1 className="flex-1 text-sm font-semibold text-slate-900">Settings</h1>
        </div>

        <nav className="flex gap-0.5 overflow-x-auto px-2 pb-1.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              onClick={() => onChangeTab(item.id)}
              className={cx(
                'whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-medium transition-colors',
                tab === item.id
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 overflow-y-auto p-3">
        {tab === 'profile' && <ProfileSettings />}
        {tab === 'source' && <SourceSettings />}
        {tab === 'answers' && <AnswersSettings />}
        {tab === 'resume' && <ResumeSettings onOpenProfile={() => onChangeTab('profile')} />}
        {tab === 'ai' && <AiSettings />}
        {tab === 'general' && <GeneralSettings />}
      </main>
    </div>
  )
}
