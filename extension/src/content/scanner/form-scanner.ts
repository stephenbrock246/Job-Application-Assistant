/**
 * Generic application form scanner (spec section 15).
 *
 * Walks the page for real, user-fillable controls and normalises each into an
 * `ApplicationField`. Everything the classifier later needs - label, type, required
 * flag, options, current value - is gathered here, in one DOM pass.
 *
 * The scanner is deliberately conservative about what counts as a field. Site
 * search boxes, cookie banners and hidden inputs produce noise that ends up as
 * bogus "needs your input" prompts, which is worse than missing a field.
 */

import { buildLocator, cssEscape, register, resetRegistry } from './locator'
import type { ApplicationField, FieldInputType } from '@/shared/types/application'

const SKIPPED_INPUT_TYPES = new Set([
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
  'search',
])

/** Containers whose contents are never part of an application form. */
const NOISE_CONTAINERS =
  'nav, header[role="banner"], footer, [role="search"], [role="navigation"], [aria-hidden="true"], [data-cookie-banner], #onetrust-consent-sdk, .cookie-banner, .cookie-consent'

import { deepQueryAll, hostOf, rootOf } from './deep-dom'

export function scanFields(): ApplicationField[] {
  resetRegistry()

  // Including controls inside web components (open shadow roots).
  const controls = deepQueryAll<HTMLElement>('input, textarea, select').filter(isScannable)

  const fields: ApplicationField[] = []
  const seenRadioGroups = new Set<string>()

  for (const control of controls) {
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      const groupKey = radioGroupKey(control)
      if (seenRadioGroups.has(groupKey)) continue
      seenRadioGroups.add(groupKey)

      const field = buildRadioGroup(control)
      if (field) fields.push(field)
      continue
    }

    const field = buildField(control)
    if (field) fields.push(field)
  }

  fields.push(...scanCustomWidgets())
  fields.push(...unreadRequiredQuestions(fields))
  return fields
}

// ---------------------------------------------------------------------------
// Site-built widgets
// ---------------------------------------------------------------------------

const PLACEHOLDER_TEXT = /^(select|choose|please (select|choose)|pick|start typing|type to|search|--|\.\.\.)/i

/**
 * A text box that suggests options as you type (location pickers, react-select).
 * Typing into one is not enough - an option has to be picked - so these are
 * scanned as `typeahead` widgets, not plain text fields.
 */
export function isTypeaheadInput(element: Element): boolean {
  if (!(element instanceof HTMLInputElement) || element.readOnly) return false
  if (!['text', 'search', ''].includes(element.type)) return false
  const autocomplete = element.getAttribute('aria-autocomplete')
  if (autocomplete && autocomplete !== 'none') return true
  if (element.getAttribute('aria-haspopup') === 'listbox') return true
  if (element.getAttribute('role') === 'combobox') return true
  return /^(start typing|type to search|begin typing)/i.test(element.getAttribute('placeholder') ?? '')
}

/** Words on buttons that act on the form rather than answer a question. */
const ACTION_WORDS =
  /\b(next|continue|back|previous|submit|apply|save|cancel|close|upload|browse|attach|add|remove|delete|edit|clear|search|sign|log|show|hide|more|less|view|download)\b/i

/**
 * Site-built controls, each with the way to operate it:
 *   listbox    - a dropdown trigger (div/button) that opens a list
 *   typeahead  - a "start typing" box that suggests options
 *   radiogroup - ARIA radio options
 *   buttons    - a row of option buttons (Ashby's Yes / No)
 */
function scanCustomWidgets(): ApplicationField[] {
  const fields: ApplicationField[] = []
  const seen = new Set<Element>()

  const triggers = document.querySelectorAll<HTMLElement>(
    '[role="combobox"]:not(input):not(select), button[aria-haspopup="listbox"], [aria-haspopup="listbox"]:not(input):not(button), input[readonly][role="combobox"], input[readonly][aria-haspopup="listbox"], input',
  )
  for (const element of triggers) {
    const typeahead = isTypeaheadInput(element)
    // `input` is in the query only to catch typeaheads; other inputs are native fields.
    if (element instanceof HTMLInputElement && !typeahead && !element.readOnly) continue
    if (element instanceof HTMLInputElement && element.readOnly && !element.matches('[role="combobox"], [aria-haspopup="listbox"]')) continue
    if (seen.has(element) || element.closest(NOISE_CONTAINERS) || !isVisible(element)) continue
    if ((element as HTMLInputElement).disabled) continue
    // A wrapper around a native control is already covered by that control.
    if (!(element instanceof HTMLInputElement) && element.querySelector('input:not([type="hidden"]), select, textarea')) {
      continue
    }
    seen.add(element)
    const label = resolveLabel(element)
    if (!label) continue
    const id = buildLocator(element)
    register(id, element)
    const shown = typeahead
      ? typeaheadValue(element as HTMLInputElement) || (element as HTMLInputElement).value.trim()
      : element instanceof HTMLInputElement
        ? element.value.trim()
        : cleanText(element.textContent)
    fields.push({
      id,
      label,
      type: 'select',
      required: resolveRequired(element, label),
      value: shown && !PLACEHOLDER_TEXT.test(shown) && shown !== label ? shown : '',
      custom: true,
      widget: typeahead ? 'typeahead' : 'listbox',
    })
  }

  for (const group of document.querySelectorAll<HTMLElement>('[role="radiogroup"]')) {
    if (group.querySelector('input[type="radio"]') || group.closest(NOISE_CONTAINERS) || !isVisible(group)) continue
    const options = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
    if (!options.length) continue
    const label = labelFromAriaLabelledBy(group) || cleanText(group.getAttribute('aria-label')) || labelFromNearbyText(group)
    if (!label) continue
    const id = buildLocator(group)
    register(id, group)
    const checked = options.find((option) => option.getAttribute('aria-checked') === 'true')
    fields.push({
      id,
      label,
      type: 'radio',
      required: group.getAttribute('aria-required') === 'true' || resolveRequired(group, label),
      value: checked ? cleanText(checked.textContent) : '',
      options: options.map((option) => cleanText(option.textContent)).filter(Boolean),
      custom: true,
      widget: 'radiogroup',
    })
  }

  fields.push(...scanButtonGroups())
  return fields
}

/** The option buttons of a button-group question, in order. */
export function optionButtons(group: Element): HTMLElement[] {
  return Array.from(group.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.matches('button, [role="button"]'),
  )
}

/** Whether a site-built option shows as chosen: ARIA state, or a selected-looking class. */
export function isChosen(option: Element): boolean {
  for (const attribute of ['aria-pressed', 'aria-checked', 'aria-selected']) {
    if (option.getAttribute(attribute) === 'true') return true
  }
  if (/^(on|active|checked|selected)$/i.test(option.getAttribute('data-state') ?? '')) return true
  return /(^|[\s_-])(active|selected|checked|pressed|is-?selected|is-?active)([\s_-]|$)/i.test(
    typeof option.className === 'string' ? option.className : '',
  )
}

/**
 * Which option of a group is chosen: ARIA state or a selected-looking class first;
 * failing that, the one option carrying a class token none of its siblings have
 * (sites mark the chosen button with an extra class, often an opaque CSS-module
 * name). -1 when nothing is chosen or it cannot be told.
 */
export function chosenIndex(options: Element[]): number {
  const explicit = options.findIndex(isChosen)
  if (explicit >= 0) return explicit
  if (options.length < 2) return -1
  const tokens = options.map((option) => new Set((typeof option.className === 'string' ? option.className : '').split(/\s+/).filter(Boolean)))
  const unique = tokens.map((set, index) =>
    [...set].some((token) => tokens.every((other, j) => j === index || !other.has(token))),
  )
  return unique.filter(Boolean).length === 1 ? unique.indexOf(true) : -1
}

/**
 * Questions answered by clicking one of a few buttons ("Yes" / "No"). Recognised
 * strictly: a container whose children are *all* short buttons, none of which is an
 * action (Next, Upload...), with a question label next to it.
 */
function scanButtonGroups(): ApplicationField[] {
  const fields: ApplicationField[] = []
  const containers = new Set<HTMLElement>()
  for (const button of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (button.parentElement) containers.add(button.parentElement)
  }

  for (const group of containers) {
    if (group.closest(NOISE_CONTAINERS) || group.closest('[role="radiogroup"], [role="listbox"], [role="menu"], [role="toolbar"]')) continue
    const options = optionButtons(group)
    if (options.length < 2 || options.length > 8 || options.length !== group.children.length) continue
    const texts = options.map((option) => cleanText(option.textContent))
    if (texts.some((text) => !text || text.length > 40 || ACTION_WORDS.test(text))) continue
    if (group.querySelector('input:not([type="hidden"]), select, textarea')) continue
    if (!isVisible(group)) continue

    const label = labelFromNearbyText(group)
    if (!label || texts.includes(label)) continue
    const id = buildLocator(group)
    register(id, group)
    const chosen = chosenIndex(options)
    fields.push({
      id,
      label,
      type: 'radio',
      required: resolveRequired(group, label),
      value: chosen >= 0 ? texts[chosen]! : '',
      options: texts,
      custom: true,
      widget: 'buttons',
    })
  }
  return fields
}

/**
 * The chosen value of a typeahead dropdown: the selected-value element its library
 * renders next to the input (react-select's single/multi value and the like). Only
 * that element is read - never surrounding text, which could be the whole form -
 * so an unknown layout reads as empty and the user is asked, never the reverse.
 */
function typeaheadValue(input: HTMLInputElement): string {
  let container: HTMLElement | null = input.parentElement
  for (let depth = 0; container && depth < 4; depth += 1) {
    const chosen = container.querySelector<HTMLElement>(
      '[class*="singleValue" i], [class*="single-value" i], [class*="multiValue" i], [class*="multi-value" i], [class*="selected-value" i]',
    )
    if (chosen) return cleanText(chosen.textContent)
    if (container.querySelector('label')) break
    container = container.parentElement
  }
  return ''
}

/**
 * Every question the page marks required with "*" should be listed, even when its
 * control is something the scanner cannot read. Those become `valueUnknown`
 * entries: the panel says "check this on the page" instead of silently omitting it.
 */
function unreadRequiredQuestions(known: ApplicationField[]): ApplicationField[] {
  const normalise = (text: string) => text.toLowerCase().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
  const knownLabels = known.map((field) => normalise(field.label)).filter((label) => label.length >= 2)
  const found: ApplicationField[] = []
  const seen = new Set<string>()
  const candidates: HTMLElement[] = []

  // 1. A "*" written in the page text.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue?.trim() ?? ''
    if (!raw.endsWith('*')) continue
    // "*" alone in its own span belongs to the label around it.
    let question = node.parentElement
    if (question && raw === '*') question = question.parentElement
    if (question) candidates.push(question)
  }
  // 2. A "*" drawn by CSS, or a label classed as required - invisible to the text walk.
  for (const label of document.querySelectorAll<HTMLElement>(
    'label, legend, [class*="label" i], [class*="title" i], [class*="question" i]',
  )) {
    if (!label.querySelector('input, select, textarea') && hasRequiredMarker(label)) candidates.push(label)
  }

  for (const question of candidates) {
    if (question.closest(NOISE_CONTAINERS) || question.closest('button, option')) continue
    if (!isVisible(question)) continue

    const text = cleanText(question.textContent)
    const clean = normalise(text)
    if (!clean || clean.length < 2 || text.length > 150) continue
    // The form's legend ("* indicates a required field") is not a question.
    if (/indicates? (a )?required|required fields?$|are required/i.test(clean)) continue
    if (seen.has(clean)) continue
    seen.add(clean)

    const matched = knownLabels.some((label) => label === clean || label.includes(clean) || clean.includes(label))
    if (matched) continue

    const id = buildLocator(question)
    register(id, question)
    found.push({
      id,
      label: text,
      type: 'unknown',
      required: true,
      value: '',
      custom: true,
      valueUnknown: true,
      unresolvedReason: 'The extension cannot read this control.',
    })
  }
  return found
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function isScannable(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement && SKIPPED_INPUT_TYPES.has(element.type)) return false
  if ((element as HTMLInputElement).disabled) return false
  // Read-only: page furniture - or a custom dropdown's trigger, which scanCustomWidgets lists.
  if ((element as HTMLInputElement).readOnly) return false
  // A type-and-pick box is scanned as a widget (scanCustomWidgets), not as plain text.
  if (isTypeaheadInput(element)) return false
  if (element.closest(NOISE_CONTAINERS)) return false
  if (isLikelySearchBox(element)) return false
  // Upload inputs are usually hidden behind a styled "Attach" button; what matters
  // is that the control around them is on screen.
  if (element instanceof HTMLInputElement && element.type === 'file') return hasVisibleContainer(element)
  if (!isVisible(element)) return false
  return true
}

function hasVisibleContainer(element: HTMLElement): boolean {
  let current = element.parentElement
  for (let depth = 0; current && depth < 4; depth += 1) {
    const rect = current.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return true
    current = current.parentElement
  }
  return false
}

function isVisible(element: HTMLElement): boolean {
  // Checkboxes and radios are frequently visually hidden behind a styled label,
  // so fall back to the nearest rendered ancestor rather than rejecting them.
  const rect = element.getBoundingClientRect()
  if (rect.width > 0 && rect.height > 0) return true

  const style = window.getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') {
    const label = element.closest('label')
    if (label) {
      const labelRect = label.getBoundingClientRect()
      return labelRect.width > 0 && labelRect.height > 0
    }
    return false
  }
  return rect.width > 0 || rect.height > 0
}

function isLikelySearchBox(element: HTMLElement): boolean {
  const haystack = [
    element.getAttribute('name'),
    element.id,
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  return /\bsearch\b|\bquery\b|\bfilter\b/.test(haystack)
}

// ---------------------------------------------------------------------------
// Field construction
// ---------------------------------------------------------------------------

function buildField(element: HTMLElement): ApplicationField | null {
  const id = buildLocator(element)
  register(id, element)

  const type = resolveType(element)
  let label = resolveLabel(element)
  if (type === 'file') label = uploadLabel(element, label)

  // A control with no discoverable label is almost always page furniture.
  if (!label && type !== 'checkbox') return null

  const field: ApplicationField = {
    id,
    label: label || humanise(element.getAttribute('name') ?? ''),
    type,
    required: resolveRequired(element, label),
    value: currentValue(element),
  }

  const options = resolveOptions(element)
  if (options.length) field.options = options

  const maxLength = (element as HTMLInputElement | HTMLTextAreaElement).maxLength
  if (typeof maxLength === 'number' && maxLength > 0) field.maxLength = maxLength

  if (element instanceof HTMLInputElement && element.type === 'file' && element.accept) {
    field.accept = element.accept
  }

  return field
}

function buildRadioGroup(control: HTMLInputElement): ApplicationField | null {
  const group = radioGroupMembers(control)
  if (!group.length) return null

  const id = buildLocator(control)
  register(id, control)
  // Register every member so a fill can target the right one.
  for (const member of group) register(buildLocator(member), member)

  const label = resolveGroupLabel(control) || resolveLabel(control)
  if (!label) return null

  const selected = group.find((input) => input.checked)

  return {
    id,
    label,
    type: 'radio',
    required: group.some((input) => resolveRequired(input, label)),
    value: selected ? labelForOption(selected) : '',
    options: group.map(labelForOption).filter(Boolean),
  }
}

function radioGroupKey(control: HTMLInputElement): string {
  const form = control.form ? (control.form.id || control.form.name || 'form') : 'no-form'
  return `${form}::${control.name || buildLocator(control)}`
}

function radioGroupMembers(control: HTMLInputElement): HTMLInputElement[] {
  if (!control.name) return [control]
  // Inside a web component the group lives in the same shadow root, which `document` cannot see into.
  const scope: ParentNode = control.form ?? (control.getRootNode() as Document | ShadowRoot)
  return Array.from(
    scope.querySelectorAll<HTMLInputElement>(
      `input[type="radio"][name="${cssEscape(control.name)}"]`,
    ),
  )
}

function resolveType(element: HTMLElement): FieldInputType {
  if (element instanceof HTMLTextAreaElement) return 'textarea'
  if (element instanceof HTMLSelectElement) return 'select'
  if (element instanceof HTMLInputElement) {
    switch (element.type) {
      case 'email':
      case 'tel':
      case 'url':
      case 'number':
      case 'date':
      case 'checkbox':
      case 'radio':
      case 'file':
        return element.type
      case 'text':
        return 'text'
      default:
        return 'text'
    }
  }
  return 'unknown'
}

function currentValue(element: HTMLElement): string {
  if (element instanceof HTMLSelectElement) {
    const selected = element.selectedOptions[0]
    // A placeholder option ("Select an option") is not a value.
    if (!selected || !selected.value || isPlaceholderOption(selected.text)) return ''
    return selected.text.trim()
  }
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return element.checked ? 'true' : ''
    if (element.type === 'file') return element.files?.[0]?.name ?? ''
    return element.value.trim()
  }
  if (element instanceof HTMLTextAreaElement) return element.value.trim()
  return ''
}

function resolveOptions(element: HTMLElement): string[] {
  if (!(element instanceof HTMLSelectElement)) return []
  return Array.from(element.options)
    .map((option) => option.text.trim())
    .filter((text) => text && !isPlaceholderOption(text))
}

export function isPlaceholderOption(text: string): boolean {
  return /^(\s*|-+|select( an?)?( option)?\.{0,3}|choose( one)?\.{0,3}|please select\.{0,3}|--.*--)$/i.test(
    text.trim(),
  )
}

// ---------------------------------------------------------------------------
// Label resolution
// ---------------------------------------------------------------------------

function resolveLabel(element: HTMLElement): string {
  const own = resolveOwnLabel(element)
  if (own) return own
  // Inside a web component with no label of its own: the component's label.
  const host = hostOf(element)
  if (host) {
    const attribute = host.getAttribute('label') ?? host.getAttribute('aria-label')
    if (attribute?.trim()) return cleanText(attribute)
    return resolveLabel(host)
  }
  return ''
}

function resolveOwnLabel(element: HTMLElement): string {
  const byLabelledBy = labelFromAriaLabelledBy(element)
  if (byLabelledBy) return byLabelledBy

  const id = element.id
  if (id) {
    const explicit = rootOf(element).querySelector<HTMLLabelElement>(`label[for="${cssEscape(id)}"]`)
    const text = explicit ? cleanText(explicit.textContent) : ''
    if (text) return text
  }

  const wrapping = element.closest('label')
  if (wrapping) {
    const text = cleanText(textExcludingControls(wrapping))
    if (text) return text
  }

  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel?.trim()) return cleanText(ariaLabel)

  const nearby = labelFromNearbyText(element)
  if (nearby) return nearby

  const placeholder = element.getAttribute('placeholder')
  if (placeholder?.trim()) return cleanText(placeholder)

  return ''
}

function labelFromAriaLabelledBy(element: HTMLElement): string {
  const ids = element.getAttribute('aria-labelledby')
  if (!ids) return ''
  const root = rootOf(element)
  const text = ids
    .split(/\s+/)
    .map((id) => root.getElementById(id)?.textContent ?? '')
    .join(' ')
  return cleanText(text)
}

/**
 * Walks up a few levels looking for the label-ish element that precedes the
 * control. Covers the very common "div > (label div) + (input wrapper)" markup
 * that Greenhouse, Lever and Workday all use in slightly different ways.
 *
 * The walk stops as soon as it would leave the control's own field container -
 * that is, the moment the parent holds more than one form control. Without that
 * bound it keeps climbing to the <form> and happily returns the page's intro
 * paragraph as the field's label, which is both wrong and confidently wrong.
 */
function labelFromNearbyText(element: HTMLElement): string {
  let current: HTMLElement | null = element
  for (let depth = 0; depth < 4 && current; depth += 1) {
    let sibling = current.previousElementSibling
    while (sibling) {
      // Another control (a country dropdown beside a phone box) is never a label.
      if (!sibling.matches('input, textarea, select, button') && !sibling.querySelector('input, textarea, select')) {
        const text = cleanText(sibling.textContent)
        // "+1" or "(555)" next to a phone box is a prefix, not the question - keep looking.
        if (text && text.length <= 160 && /\p{L}/u.test(text)) return text
      }
      sibling = sibling.previousElementSibling
    }

    const parent: HTMLElement | null = current.parentElement
    if (!parent) break

    // A fieldset legend is authoritative when present.
    if (parent.tagName === 'FIELDSET') {
      const legend = parent.querySelector('legend')
      const text = legend ? cleanText(legend.textContent) : ''
      if (text) return text
    }

    // Shared container reached - anything above belongs to the form, not this field.
    // One exception: a small compound field (country code + number, day/month/year)
    // is labelled above the group, so read the group's own heading - and stop there.
    const controls = parent.querySelectorAll('input, textarea, select').length
    if (controls > 1) {
      if (controls <= 3) {
        const heading = parent.previousElementSibling
        const text = heading && !heading.querySelector('input, textarea, select') ? cleanText(heading.textContent) : ''
        if (text && text.length <= 60 && /\p{L}/u.test(text)) return text
      }
      break
    }

    current = parent
  }
  return ''
}

const UPLOAD_SUBJECT = /r[eé]sum[eé]|\bcv\b|curriculum|cover\s*letter|motivation/i

/**
 * Upload inputs sit inside a drop zone whose own text ("Drag and drop a file or
 * browse") says nothing about *what* to upload. The question is the heading above
 * the zone ("Upload Your Resume *"), so look there when the nearby text does not
 * say resume or cover letter.
 */
function uploadLabel(element: HTMLElement, nearby: string): string {
  if (UPLOAD_SUBJECT.test(nearby)) return nearby
  let current: HTMLElement | null = element
  for (let depth = 0; current && depth < 6; depth += 1) {
    let sibling = current.previousElementSibling
    for (let hops = 0; sibling && hops < 3; hops += 1) {
      const text = cleanText(sibling.textContent)
      if (text && text.length <= 120 && UPLOAD_SUBJECT.test(text)) return text
      sibling = sibling.previousElementSibling
    }
    current = current.parentElement
  }
  return nearby
}

function resolveGroupLabel(control: HTMLInputElement): string {
  const fieldset = control.closest('fieldset')
  if (fieldset) {
    const legend = fieldset.querySelector('legend')
    const text = legend ? cleanText(legend.textContent) : ''
    if (text) return text
  }

  const group = control.closest('[role="radiogroup"], [role="group"]')
  if (group) {
    const labelledBy = labelFromAriaLabelledBy(group as HTMLElement)
    if (labelledBy) return labelledBy
    const ariaLabel = group.getAttribute('aria-label')
    if (ariaLabel?.trim()) return cleanText(ariaLabel)
  }

  return labelFromNearbyText(control)
}

/** The visible text of a radio/checkbox option, used as its value. */
function labelForOption(input: HTMLInputElement): string {
  const wrapping = input.closest('label')
  if (wrapping) {
    const text = cleanText(textExcludingControls(wrapping))
    if (text) return text
  }
  if (input.id) {
    const explicit = document.querySelector<HTMLLabelElement>(`label[for="${cssEscape(input.id)}"]`)
    const text = explicit ? cleanText(explicit.textContent) : ''
    if (text) return text
  }
  const aria = input.getAttribute('aria-label')
  if (aria?.trim()) return cleanText(aria)
  return input.value.trim()
}

function textExcludingControls(root: Element): string {
  const clone = root.cloneNode(true) as Element
  clone.querySelectorAll('input, textarea, select, button').forEach((node) => node.remove())
  return clone.textContent ?? ''
}

// ---------------------------------------------------------------------------
// Required detection
// ---------------------------------------------------------------------------

function resolveRequired(element: HTMLElement, label: string): boolean {
  if ((element as HTMLInputElement).required) return true
  if (element.getAttribute('aria-required') === 'true') return true

  // Sites mark requiredness visually far more often than semantically.
  if (/\*\s*$/.test(label.trim()) || /\(required\)/i.test(label)) return true

  const container = element.closest('[class*="required" i], [data-required="true"]')
  if (container) return true

  const describedBy = element.getAttribute('aria-describedby')
  if (describedBy) {
    const text = describedBy
      .split(/\s+/)
      .map((id) => rootOf(element).getElementById(id)?.textContent ?? '')
      .join(' ')
    if (/required/i.test(text)) return true
  }

  // The label's own marker: a `required` class, or a "*" drawn by CSS (::after),
  // which is not in the page text at all. Check the <label for> and the labels
  // sitting just before the control or its wrappers.
  if (element.id) {
    const explicit = rootOf(element).querySelector(`label[for="${cssEscape(element.id)}"]`)
    if (explicit && hasRequiredMarker(explicit)) return true
  }
  // A web component marked required on its host (<x-input required>).
  const host = hostOf(element)
  if (host && (host.hasAttribute('required') || host.getAttribute('aria-required') === 'true')) return true
  let current: Element | null = element
  for (let depth = 0; current && depth < 4; depth += 1) {
    const before = current.previousElementSibling
    if (before && !before.querySelector('input, select, textarea') && hasRequiredMarker(before)) return true
    current = current.parentElement
    if (current && current.querySelectorAll('input, select, textarea, button').length > 8) break
  }

  return false
}

/** A label marked required: by class, data attribute, or a CSS-drawn "*". */
function hasRequiredMarker(element: Element): boolean {
  const className = typeof element.className === 'string' ? element.className : ''
  if (/(^|[\s_-])required([\s_-]|$)/i.test(className)) return true
  if (element.getAttribute('data-required') === 'true') return true
  if (cleanText(element.textContent).length > 150) return false
  for (const pseudo of ['::after', '::before'] as const) {
    try {
      const content = window.getComputedStyle(element, pseudo).content
      if (content && content.includes('*')) return true
    } catch {
      /* environments without pseudo-element styles */
    }
  }
  // A child that only exists to draw the marker: <span class="required"></span>.
  return Boolean(element.querySelector('[class*="required" i]'))
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function cleanText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .replace(/Â /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function humanise(name: string): string {
  return name
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
}

