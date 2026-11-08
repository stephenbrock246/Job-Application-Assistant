/**
 * Filling site-built controls the way a person does: click the option.
 *
 *   buttons     click the button whose text matches (Ashby's Yes / No)
 *   radiogroup  click the matching role="radio" option
 *   listbox     open the dropdown, click the matching option
 *   typeahead   type the search term, wait for suggestions, click the matching one
 *
 * Choosing uses the same strict matcher as native dropdowns (`bestOption`): no
 * clear match means no click - a wrong pick is invisible and gets submitted. Every
 * fill is verified on the page afterwards; a click that did not take is a failure.
 */

import { resolve } from '../scanner/locator'
import { chosenIndex, isChosen, optionButtons } from '../scanner/form-scanner'
import { bestOption } from './fill-element'
import type { FillInstruction, FillOutcome } from '@/shared/types/application'

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const text = (element: Element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim()

export async function fillWidget(instruction: FillInstruction): Promise<FillOutcome> {
  const element = resolve(instruction.fieldId)
  const fail = (error: string): FillOutcome => ({ fieldId: instruction.fieldId, filled: false, error })
  if (!(element instanceof HTMLElement)) return fail('Field is no longer on the page.')

  try {
    switch (instruction.widget) {
      case 'buttons':
        return await chooseAmong(instruction, element, optionButtons(element))
      case 'radiogroup':
        return await chooseAmong(instruction, element, Array.from(element.querySelectorAll<HTMLElement>('[role="radio"]')))
      case 'listbox':
        return await pickFromList(instruction, element)
      case 'typeahead':
        return await typeAndPick(instruction, element as HTMLInputElement)
      default:
        return fail('Unsupported control type.')
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Could not fill this field.')
  }
}

/** Option buttons / ARIA radios: click the matching one and check it shows as chosen. */
async function chooseAmong(instruction: FillInstruction, group: HTMLElement, options: HTMLElement[]): Promise<FillOutcome> {
  const labels = options.map(text)
  const index = bestOption(labels, instruction.value)
  if (index === null) {
    return { fieldId: instruction.fieldId, filled: false, error: `No option matches "${instruction.value}".` }
  }
  const target = options[index]!
  if (chosenIndex(options) === index) return { fieldId: instruction.fieldId, filled: true, actualValue: labels[index] }

  realClick(target)
  await sleep(250)

  // Re-read the group (sites often re-render it) and require *this* option chosen.
  const after = instruction.widget === 'buttons'
    ? optionButtons(group)
    : Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
  const took = chosenIndex(after.length ? after : options) === index
  return {
    fieldId: instruction.fieldId,
    filled: took,
    actualValue: labels[index],
    ...(took ? {} : { error: 'The option did not stay selected.' }),
  }
}

/** A dropdown trigger: open it, click the matching option, check the trigger shows it. */
async function pickFromList(instruction: FillInstruction, trigger: HTMLElement): Promise<FillOutcome> {
  realClick(trigger)
  const options = await waitForOptions(trigger, 2_000)
  const labels = options.map(text)
  const index = bestOption(labels, instruction.value)
  if (index === null) {
    closeList(trigger)
    return {
      fieldId: instruction.fieldId,
      filled: false,
      error: options.length ? `No option matches "${instruction.value}".` : 'The list did not open.',
    }
  }
  realClick(options[index]!)
  await sleep(300)
  const shown = text(trigger)
  const took = shown.includes(labels[index]!) || isChosen(options[index]!)
  return {
    fieldId: instruction.fieldId,
    filled: took,
    actualValue: labels[index],
    ...(took ? {} : { error: 'The dropdown did not keep the choice.' }),
  }
}

/**
 * A "start typing" box: type the search term, wait for suggestions, click the one
 * that matches. For a location like "Riga, Latvia" the city is typed and the
 * suggestion is chosen by the rest ("Latvia") when several start with the city.
 */
async function typeAndPick(instruction: FillInstruction, input: HTMLInputElement): Promise<FillOutcome> {
  const parts = instruction.value.split(',').map((part) => part.trim()).filter(Boolean)
  const term = parts[0] ?? instruction.value.trim()

  input.focus()
  realClick(input)
  setNativeValue(input, term)
  input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: term }))

  const options = await waitForOptions(input, 3_000)
  const labels = options.map(text)
  let index = bestOption(labels, instruction.value)
  if (index === null) {
    // Suggestions that start with the typed term; the rest of the value breaks ties.
    const lower = (s: string) => s.toLowerCase()
    const starting = labels
      .map((label, i) => ({ label, i }))
      .filter(({ label }) => lower(label).startsWith(lower(term)))
    const rest = parts.slice(1).map(lower)
    const preferred = starting.find(({ label }) => rest.some((part) => lower(label).includes(part)))
    index = (preferred ?? (starting.length === 1 ? starting[0] : undefined))?.i ?? null
  }

  if (index === null) {
    // Leave nothing half-typed behind: an unchosen search term reads as an answer.
    setNativeValue(input, '')
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
    closeList(input)
    return {
      fieldId: instruction.fieldId,
      filled: false,
      error: options.length
        ? `None of the suggestions clearly matches "${instruction.value}" - choose one on the page.`
        : `No suggestions appeared for "${term}".`,
    }
  }

  realClick(options[index]!)
  await sleep(300)
  const shownNow = (input.value || '').trim()
  const took = !options[index]!.isConnected || shownNow.length > term.length || shownNow === labels[index]
  return {
    fieldId: instruction.fieldId,
    filled: took,
    actualValue: labels[index],
    ...(took ? {} : { error: 'The suggestion was not accepted.' }),
  }
}

// ---------------------------------------------------------------------------

/** The options a control opened: its aria-controls/aria-owns list, else any visible option. */
async function waitForOptions(anchor: HTMLElement, timeoutMs: number): Promise<HTMLElement[]> {
  const deadline = Date.now() + timeoutMs
  let previous = -1
  while (Date.now() < deadline) {
    const listId = anchor.getAttribute('aria-controls') || anchor.getAttribute('aria-owns')
    const scope = (listId && document.getElementById(listId)) || document
    const options = Array.from(scope.querySelectorAll<HTMLElement>('[role="option"]')).filter(
      (option) => option.getBoundingClientRect().height > 0 && option.getAttribute('aria-disabled') !== 'true',
    )
    // Wait for the list to stop growing (suggestions often arrive in a second batch).
    if (options.length && options.length === previous) return options
    previous = options.length
    await sleep(150)
  }
  return []
}

function closeList(anchor: HTMLElement): void {
  anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  anchor.blur()
}

/** The full press sequence: many widgets act on pointer/mouse down, not just click. */
function realClick(element: HTMLElement): void {
  element.scrollIntoView?.({ block: 'center' })
  const init = { bubbles: true, cancelable: true, view: window, button: 0 }
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
  element.dispatchEvent(new Pointer('pointerdown', init))
  element.dispatchEvent(new MouseEvent('mousedown', init))
  element.dispatchEvent(new Pointer('pointerup', init))
  element.dispatchEvent(new MouseEvent('mouseup', init))
  element.dispatchEvent(new MouseEvent('click', init))
}

function setNativeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
}
