/**
 * Scrolls a field into view and outlines it briefly.
 *
 * Used when the user taps a "needs information" row in the panel: the point of an
 * assisted tool is that you can always see which box on the page is being talked
 * about.
 */

import { resolve } from './scanner/locator'

const STYLE_ID = 'jobapply-assistant-highlight-style'
const CLASS_NAME = 'jobapply-assistant-highlight'

export function highlightField(fieldId: string): void {
  const element = resolve(fieldId)
  if (!(element instanceof HTMLElement)) return

  injectStyle()

  // Radios and checkboxes are often visually hidden; outline their label instead.
  const target = isRenderable(element) ? element : (element.closest('label') as HTMLElement) ?? element

  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add(CLASS_NAME)
  window.setTimeout(() => target.classList.remove(CLASS_NAME), 2200)
}

function isRenderable(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .${CLASS_NAME} {
      outline: 2px solid #2563eb !important;
      outline-offset: 2px !important;
      border-radius: 4px;
      animation: jobapply-assistant-pulse 1.1s ease-in-out 2;
    }
    @keyframes jobapply-assistant-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.45); }
      50% { box-shadow: 0 0 0 6px rgba(37, 99, 235, 0); }
    }
  `
  document.head.appendChild(style)
}
