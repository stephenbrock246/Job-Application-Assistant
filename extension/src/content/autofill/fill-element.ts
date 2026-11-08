/**
 * Writing values into form controls.
 *
 * Setting `element.value` directly is invisible to React, Vue and Angular, because
 * their change tracking hooks the property setter on the prototype. We call the
 * *native* setter and then dispatch the events the framework listens for, which is
 * what makes a filled value survive the page's own re-render.
 *
 * Every write is verified by reading the DOM back. A fill that did not take is
 * reported as a failure rather than assumed to have worked.
 */

import { isPlaceholderOption } from '../scanner/form-scanner'
import { cssEscape, resolve } from '../scanner/locator'
import type { FillInstruction, FillOutcome } from '@/shared/types/application'

export function fillFields(instructions: FillInstruction[]): FillOutcome[] {
  return instructions.map(fillOne)
}

function fillOne(instruction: FillInstruction): FillOutcome {
  const element = resolve(instruction.fieldId)
  if (!element) {
    return { fieldId: instruction.fieldId, filled: false, error: 'Field is no longer on the page.' }
  }

  try {
    if (element instanceof HTMLSelectElement) return fillSelect(element, instruction)
    if (element instanceof HTMLInputElement) {
      if (element.type === 'radio') return fillRadio(element, instruction)
      if (element.type === 'checkbox') return fillCheckbox(element, instruction)
      if (element.type === 'file') {
        return {
          fieldId: instruction.fieldId,
          filled: false,
          error: 'File uploads must be done by you.',
        }
      }
      return fillText(element, instruction)
    }
    if (element instanceof HTMLTextAreaElement) return fillText(element, instruction)

    return { fieldId: instruction.fieldId, filled: false, error: 'Unsupported control type.' }
  } catch (error) {
    return {
      fieldId: instruction.fieldId,
      filled: false,
      error: error instanceof Error ? error.message : 'Could not fill this field.',
    }
  }
}

// ---------------------------------------------------------------------------

function fillText(
  element: HTMLInputElement | HTMLTextAreaElement,
  instruction: FillInstruction,
): FillOutcome {
  element.focus()
  setNativeValue(element, instruction.value)
  dispatchInputEvents(element)
  element.blur()

  const actual = element.value
  return {
    fieldId: instruction.fieldId,
    filled: actual === instruction.value,
    actualValue: actual,
    ...(actual === instruction.value ? {} : { error: 'The page rejected or rewrote the value.' }),
  }
}

function fillSelect(element: HTMLSelectElement, instruction: FillInstruction): FillOutcome {
  const options = Array.from(element.options).filter((option) => !isPlaceholderOption(option.text))
  const match = bestOption(
    options.map((option) => option.text),
    instruction.value,
  )

  if (match === null) {
    return {
      fieldId: instruction.fieldId,
      filled: false,
      error: `No option matches "${instruction.value}".`,
    }
  }

  const option = options[match]!
  element.focus()
  setNativeValue(element, option.value)
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  element.blur()

  const actual = element.selectedOptions[0]?.text.trim() ?? ''
  return {
    fieldId: instruction.fieldId,
    filled: element.value === option.value,
    actualValue: actual,
    ...(element.value === option.value ? {} : { error: 'The page reset the selection.' }),
  }
}

function fillRadio(element: HTMLInputElement, instruction: FillInstruction): FillOutcome {
  const group = element.name
    ? Array.from(
        (element.form ?? (element.getRootNode() as Document | ShadowRoot)).querySelectorAll<HTMLInputElement>(
          `input[type="radio"][name="${cssEscape(element.name)}"]`,
        ),
      )
    : [element]

  const labels = group.map(optionLabel)
  const match = bestOption(labels, instruction.value)
  if (match === null) {
    return {
      fieldId: instruction.fieldId,
      filled: false,
      error: `No option matches "${instruction.value}".`,
    }
  }

  const target = group[match]!
  // click() drives the site's own handlers, which is what styled radios rely on.
  target.click()
  if (!target.checked) {
    target.checked = true
    target.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }

  return {
    fieldId: instruction.fieldId,
    filled: target.checked,
    actualValue: labels[match],
    ...(target.checked ? {} : { error: 'The option did not stay selected.' }),
  }
}

function fillCheckbox(element: HTMLInputElement, instruction: FillInstruction): FillOutcome {
  const shouldCheck = isAffirmative(instruction.value)
  if (element.checked !== shouldCheck) {
    element.click()
    if (element.checked !== shouldCheck) {
      element.checked = shouldCheck
      element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }
  }

  return {
    fieldId: instruction.fieldId,
    filled: element.checked === shouldCheck,
    actualValue: element.checked ? 'true' : '',
  }
}

// ---------------------------------------------------------------------------

function setNativeValue(element: HTMLElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) descriptor.set.call(element, value)
  else (element as HTMLInputElement).value = value
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

function optionLabel(input: HTMLInputElement): string {
  const wrapping = input.closest('label')
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement
    clone.querySelectorAll('input, textarea, select, button').forEach((node) => node.remove())
    const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  if (input.id) {
    const explicit = document.querySelector<HTMLLabelElement>(`label[for="${cssEscape(input.id)}"]`)
    const text = (explicit?.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return input.value.trim()
}

/**
 * Finds the option index that best matches a value.
 * Returns null rather than a weak guess - picking the wrong dropdown entry is a
 * silent, invisible error on a form the user is about to submit.
 */
export function bestOption(options: string[], value: string): number | null {
  const target = normalise(value)
  if (!target) return null

  // A placeholder ("—", "Select...") normalises to nothing and must never match.
  const normalised = options.map(normalise)
  const usable = (index: number) => normalised[index]!.length > 0 && !/^(select|choose|please select)\b/.test(normalised[index]!)
  const find = (test: (option: string) => boolean) => normalised.findIndex((option, index) => usable(index) && test(option))

  const exact = find((option) => option === target)
  if (exact >= 0) return exact

  // Yes/no questions are the most common select in an application form. "No" is
  // decided first: "I do not require sponsorship" starts like a yes but is a no.
  const wantNo = isNegative(value)
  const wantYes = !wantNo && isAffirmative(value)
  if (wantNo || wantYes) {
    const index = find((option) => (wantNo ? isNegative(option) : isAffirmative(option)))
    if (index >= 0) return index
    // A yes/no answer never falls through to text matching ("No" is not "Norway").
    return null
  }

  // The start of the option ("Nigeria" -> "Nigeria (+234)"); both sides long enough to mean something.
  const startsWith = find(
    (option) => Math.min(option.length, target.length) >= 3 && (option.startsWith(target) || target.startsWith(option)),
  )
  if (startsWith >= 0) return startsWith

  // Whole words only: "Man" must not pick "Woman".
  if (target.length >= 3) {
    const contains = find((option) => option.length >= 3 && (hasWords(option, target) || hasWords(target, option)))
    if (contains >= 0) return contains
  }

  return null
}

function hasWords(text: string, words: string): boolean {
  return ` ${text} `.includes(` ${words} `)
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "not", "don't", "never"... anywhere in an answer that otherwise starts like a yes. */
const NEGATION = /\b(not|no|never|dont|doesnt|wont|cant|cannot|isnt|arent|havent)\b/

export function isNegative(value: string): boolean {
  const text = normalise(value)
  if (/^(n|0)$/.test(text) || /^(no|false|none|not)\b/.test(text)) return true
  if (/^(i am|im|i do|i will|i have|i would|i can)\b/.test(text) && NEGATION.test(text)) return true
  return /^(i dont|i wont|i cant|i do not|i am not|im not)\b/.test(text)
}

export function isAffirmative(value: string): boolean {
  const text = normalise(value)
  if (isNegative(value)) return false
  return /^(y|1)$/.test(text) || /^(yes|true|authorized|checked|i am|im|i do|i will|i have|i would|i can)\b/.test(text)
}

