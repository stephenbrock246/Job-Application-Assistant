/**
 * Validation-error detection.
 *
 * Used two ways: after a fill, to notice that the page rejected a value, and (in
 * phase 4) after clicking Next, to distinguish "the page advanced" from "the page
 * refused". Both browser-native constraint failures and the site's own rendered
 * error messages count.
 */

import { buildLocator } from '../scanner/locator'
import type { ValidationError } from '@/shared/types/application'

const ERROR_SELECTORS = [
  '[aria-invalid="true"]',
  '[role="alert"]',
  '.error:not(:empty)',
  '.errors:not(:empty)',
  '.field-error',
  '.invalid-feedback',
  '.help-block.error',
  '[class*="errorMessage" i]',
  '[class*="error-message" i]',
  '[data-automation-id*="error" i]',
]

export function detectValidationErrors(): ValidationError[] {
  const errors: ValidationError[] = []
  const seen = new Set<string>()

  // 1. Native constraint validation.
  const controls = document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    'input, select, textarea',
  )
  for (const control of controls) {
    if (control.disabled || control.type === 'hidden') continue
    // Controls of a later step (or a collapsed section) are present but not shown: not this page's errors.
    if (hiddenByStyle(control)) continue
    // `validity` reads the state without firing the page's own "invalid" handlers.
    if (!control.validity || control.validity.valid) continue

    const message = control.validationMessage || 'This field is invalid.'
    const fieldId = buildLocator(control)
    if (addUnique(seen, `${fieldId}::${message}`)) errors.push({ fieldId, message })
  }

  // 2. Messages the site rendered itself.
  for (const selector of ERROR_SELECTORS) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (!isVisible(element)) continue

      const message = cleanText(element.textContent)
      if (!message || message.length > 300) continue
      // `aria-invalid` marks the control, not the message; look nearby for the text.
      const text = message || describedByText(element)
      if (!text) continue

      const related = element.matches('input, select, textarea')
        ? element
        : element.closest('label, fieldset, div')?.querySelector('input, select, textarea')

      const fieldId = related ? buildLocator(related) : undefined
      if (addUnique(seen, `${fieldId ?? ''}::${text}`)) {
        errors.push(fieldId ? { fieldId, message: text } : { message: text })
      }
    }
  }

  return errors
}

function describedByText(element: HTMLElement): string {
  const ids = element.getAttribute('aria-describedby')
  if (!ids) return ''
  return cleanText(
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
  )
}

/** Hidden by the page: the hidden attribute, display:none or visibility:hidden on it or an ancestor. */
function hiddenByStyle(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return true
    const style = getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return true
  }
  return false
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function cleanText(text: string | null): string {
  if (!text) return ''
  return text.replace(/\s+/g, ' ').trim()
}

function addUnique(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false
  seen.add(key)
  return true
}
