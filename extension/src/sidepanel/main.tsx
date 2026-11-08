import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SidePanel } from './SidePanel'
import { AppStateProvider } from './state/AppStateContext'
import { installPanelCrashHandlers } from './lib/diagnostics'
import './index.css'

installPanelCrashHandlers()

const container = document.getElementById('root')
if (!container) throw new Error('Side panel root element is missing.')

createRoot(container).render(
  <StrictMode>
    <AppStateProvider>
      <SidePanel />
    </AppStateProvider>
  </StrictMode>,
)
