/**
 * A copy of the page for a problem report, readable offline.
 *
 * Typed-in values live in element properties, not in the markup, so a plain
 * outerHTML would show an empty form. They are copied into attributes on a clone
 * (never on the live page). Open shadow roots are written as declarative shadow
 * DOM so web-component forms render too. Scripts are dropped: the copy is for
 * looking at, and must not run the site's code when opened.
 */

/** About 1.5 MB of markup; past that the copy is cut, and says so. */
export const SNAPSHOT_MAX_CHARS = 1_500_000

const CONTROLS = 'input, textarea, select'

export function pageHtml(source: HTMLElement = document.documentElement): { html: string; truncated: boolean } {
  const clone = source.cloneNode(true) as HTMLElement

  // A deep clone keeps document order, so the nth control of each is the same control.
  const live = Array.from(source.querySelectorAll(CONTROLS))
  const copies = Array.from(clone.querySelectorAll(CONTROLS))
  live.forEach((element, index) => {
    const copy = copies[index]
    if (copy) copyValue(element, copy)
  })

  // Shadow roots are not cloned: write each open one into its host's copy.
  const liveAll = Array.from(source.querySelectorAll('*'))
  const copyAll = Array.from(clone.querySelectorAll('*'))
  liveAll.forEach((element, index) => {
    const root = element.shadowRoot
    const copy = copyAll[index]
    if (!root || !copy) return
    const template = copy.ownerDocument.createElement('template')
    template.setAttribute('shadowrootmode', 'open')
    template.innerHTML = root.innerHTML
    copy.prepend(template)
  })

  for (const element of Array.from(clone.querySelectorAll('script, noscript'))) element.remove()

  // Relative stylesheets and images resolve against the site when the copy is opened.
  const head = clone.querySelector('head')
  if (head) {
    const base = clone.ownerDocument.createElement('base')
    base.setAttribute('href', location.href)
    head.prepend(base)
  }

  let html = `<!doctype html>\n<!-- JobApply problem report: copy of ${location.href} at ${new Date().toISOString()} -->\n${clone.outerHTML}`
  const truncated = html.length > SNAPSHOT_MAX_CHARS
  if (truncated) html = `${html.slice(0, SNAPSHOT_MAX_CHARS)}\n<!-- copy cut at ${SNAPSHOT_MAX_CHARS} characters -->`
  return { html, truncated }
}

function copyValue(element: Element, copy: Element): void {
  if (element instanceof HTMLInputElement) {
    const type = element.type.toLowerCase()
    if (type === 'password') copy.setAttribute('value', element.value ? '********' : '')
    else if (type === 'checkbox' || type === 'radio') toggle(copy, 'checked', element.checked)
    else if (type !== 'file') copy.setAttribute('value', element.value)
    return
  }
  if (element instanceof HTMLTextAreaElement) {
    copy.textContent = element.value
    return
  }
  if (element instanceof HTMLSelectElement) {
    const options = Array.from(copy.querySelectorAll('option'))
    Array.from(element.options).forEach((option, index) => {
      const target = options[index]
      if (target) toggle(target, 'selected', option.selected)
    })
  }
}

function toggle(element: Element, attribute: string, on: boolean): void {
  if (on) element.setAttribute(attribute, '')
  else element.removeAttribute(attribute)
}
