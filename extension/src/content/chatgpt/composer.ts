/**
 * The chat's own message box - and only that one.
 *
 * Chat pages hold other editable areas: an answer opened in a canvas / document
 * editor, a message being edited, a code block. They match the same generic
 * selectors ("div.ProseMirror[contenteditable]", "[role=textbox]") and come
 * earlier on the page than the message box, so "the first match" typed the job
 * description into the last answer. Here every candidate is checked: editable,
 * shown, outside the conversation, and the one the chat's Send button belongs to.
 * After typing, the text must be in that box and nowhere else.
 */

/** Parts of the page that are never the message box: messages, answers, canvases, editors in a turn. */
const NOT_COMPOSER = [
  '[data-message-author-role]',
  '[data-message-id]',
  '[data-testid^="conversation-turn"]',
  '[data-testid="user-message"]',
  '[data-is-streaming]',
  '[data-testid*="canvas" i]',
  '[data-testid*="textdoc" i]',
  '[role="dialog"]',
  'article',
].join(',')

export interface ComposerSelectors {
  composer: string[]
  send: string[]
}

/** True when the element is part of the conversation or a canvas - not the message box. */
export function inConversation(element: Element): boolean {
  return Boolean(element.closest(NOT_COMPOSER))
}

function editable(element: HTMLElement): boolean {
  if (!element.isConnected) return false
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly
  return element.isContentEditable || element.getAttribute('contenteditable') === 'true'
}

function shown(element: HTMLElement): boolean {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  }
  return true
}

/** The Send button that belongs to this box: inside its form / composer area, never in the conversation. */
export function sendButtonFor(composer: HTMLElement, selectors: readonly string[]): HTMLButtonElement | null {
  const scopes = [
    composer.closest('form'),
    composer.closest('[data-testid*="composer" i], [class*="composer" i], fieldset'),
  ].filter((scope): scope is HTMLElement => Boolean(scope))
  for (const scope of scopes) {
    for (const selector of selectors) {
      const button = [...scope.querySelectorAll<HTMLButtonElement>(selector)].find((b) => !inConversation(b) && shown(b))
      if (button) return button
    }
  }
  // No form around it (the page changed): a Send button outside the conversation, nearest after the box.
  const loose = selectors.flatMap((selector) => [...document.querySelectorAll<HTMLButtonElement>(selector)]).filter((b) => !inConversation(b) && shown(b))
  return loose.find((b) => composer.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ?? loose[0] ?? null
}

/**
 * The message box. Candidates from every selector, in that order of preference,
 * keeping only editable, shown ones outside the conversation; among those, one
 * with its own Send button wins, then the last on the page (the box is at the bottom).
 */
export function findComposer(selectors: ComposerSelectors): HTMLElement | null {
  const seen = new Set<HTMLElement>()
  const candidates: HTMLElement[] = []
  for (const selector of selectors.composer) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      if (seen.has(element)) continue
      seen.add(element)
      if (editable(element) && shown(element) && !inConversation(element)) candidates.push(element)
    }
  }
  if (!candidates.length) return null
  const withForm = candidates.filter((element) => element.closest('form, [data-testid*="composer" i]'))
  // The first selector is the box's own id: trust it when it passes the checks.
  return (candidates[0]!.matches(selectors.composer[0]!) ? candidates[0] : null) ?? withForm.at(-1) ?? candidates.at(-1)!
}

function textOf(element: HTMLElement): string {
  return element instanceof HTMLTextAreaElement ? element.value : (element.innerText ?? element.textContent ?? '')
}

/**
 * Types `text` into the box, replacing what is there, and checks it landed there.
 * `marker`: a short piece of `text` (the reference) used to check no other place got it.
 * Throws with a clear message when the box did not take the text.
 */
export function typeInto(composer: HTMLElement, text: string, marker: string, site: string): void {
  const elsewhereBefore = markerElsewhere(composer, marker)
  composer.scrollIntoView?.({ block: 'nearest' })
  composer.focus()

  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(composer, text)
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
  } else {
    // Rich-text box (ProseMirror): select its own contents, then insert through the
    // editor's input path. The selection is put inside the box explicitly, so the
    // text cannot go where the focus or cursor happened to be (a canvas, an answer).
    selectContents(composer)
    let inserted = selectionInside(composer) && command('insertText', text)
    if (!inserted || !textOf(composer).includes(marker)) {
      // Fallback: a paste into the box, which the editor also handles.
      selectContents(composer)
      if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function') {
        const data = new DataTransfer()
        data.setData('text/plain', text)
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      }
      inserted = textOf(composer).includes(marker)
    }
  }

  if (markerElsewhere(composer, marker) > elsewhereBefore) {
    // Typed into the wrong place: take it back so nothing is sent from there.
    command('undo')
    throw new Error(`The message went into another part of the ${site} page instead of the message box. Close any open canvas or message editor in the ${site} tab, then press Retry.`)
  }
  if (!textOf(composer).includes(marker)) {
    throw new Error(`Could not type into ${site}'s message box. Click into the ${site} tab once, then press Retry.`)
  }
}

/** document.execCommand where the page offers it; false where it does not. */
function command(name: string, value?: string): boolean {
  try {
    return typeof document.execCommand === 'function' && document.execCommand(name, false, value)
  } catch {
    return false
  }
}

function selectContents(element: HTMLElement): void {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.selectNodeContents(element)
  selection.removeAllRanges()
  selection.addRange(range)
}

function selectionInside(element: HTMLElement): boolean {
  const selection = window.getSelection()
  const anchor = selection?.anchorNode
  return Boolean(anchor && (anchor === element || element.contains(anchor)))
}

/** How many editable places other than the box hold the marker. */
function markerElsewhere(composer: HTMLElement, marker: string): number {
  let count = 0
  for (const element of document.querySelectorAll<HTMLElement>('[contenteditable="true"], textarea')) {
    if (element === composer || composer.contains(element) || element.contains(composer)) continue
    if (textOf(element).includes(marker)) count += 1
  }
  return count
}
