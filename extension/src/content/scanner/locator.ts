/**
 * Stable field identity.
 *
 * A field's id has to survive a rescan of the same page, and has to be resolvable
 * back to a live element after the panel round-trips it. We build a CSS locator
 * that prefers stable attributes (id, name, data-* test hooks) and only falls back
 * to structural nth-of-type paths when nothing better exists.
 *
 * A registry populated during the scan is consulted first, so the common case never
 * depends on the locator still matching.
 */

import { isShadowRoot } from './deep-dom'

const registry = new Map<string, Element>()

export function resetRegistry(): void {
  registry.clear()
}

export function register(id: string, element: Element): void {
  registry.set(id, element)
}

/** Separates the steps of a locator that goes through shadow roots: "host >>> inner". */
const SHADOW_STEP = ' >>> '

export function resolve(id: string): Element | null {
  const cached = registry.get(id)
  if (cached?.isConnected) return cached

  // The locator is the id itself for everything except structural fallbacks;
  // inside web components it is one selector per shadow root.
  try {
    let scope: Document | ShadowRoot | null = document
    let found: Element | null = null
    for (const step of id.split(SHADOW_STEP)) {
      if (!scope) return null
      found = scope.querySelector(step)
      if (!found) return null
      scope = found.shadowRoot
    }
    return found
  } catch {
    /* not a valid selector - fall through */
  }
  return null
}

const SAFE_ATTRS = ['data-testid', 'data-test-id', 'data-qa', 'data-automation-id', 'name']

export function buildLocator(element: Element): string {
  // Inside a web component: the host's locator, then this element's within the shadow root.
  const root = element.getRootNode()
  if (isShadowRoot(root)) return `${buildLocator(root.host)}${SHADOW_STEP}${locatorWithin(element, root)}`
  return locatorWithin(element, document)
}

function locatorWithin(element: Element, scope: Document | ShadowRoot): string {
  const tag = element.tagName.toLowerCase()

  if (element.id && isUnique(`#${cssEscape(element.id)}`, scope)) {
    return `#${cssEscape(element.id)}`
  }

  for (const attr of SAFE_ATTRS) {
    const value = element.getAttribute(attr)
    if (!value) continue
    const selector = `${tag}[${attr}="${cssEscape(value)}"]`
    if (isUnique(selector, scope)) return selector
    // Radio groups legitimately share a name; disambiguate by value.
    const groupValue = element.getAttribute('value')
    if (groupValue) {
      const withValue = `${selector}[value="${cssEscape(groupValue)}"]`
      if (isUnique(withValue, scope)) return withValue
    }
  }

  return structuralPath(element, scope)
}

function isUnique(selector: string, scope: Document | ShadowRoot = document): boolean {
  try {
    return scope.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function structuralPath(element: Element, scope: Document | ShadowRoot = document): string {
  const parts: string[] = []
  let current: Element | null = element
  const inShadow = isShadowRoot(scope)

  while (current && current !== document.body && parts.length < 8) {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) {
      // The top of a shadow root: position among the root's own children.
      const siblings = inShadow ? Array.from(scope.children).filter((child) => child.tagName === current!.tagName) : []
      parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag)
      break
    }

    const siblings = Array.from(parent.children).filter((child) => child.tagName === current!.tagName)
    const index = siblings.indexOf(current) + 1
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
    current = parent
  }

  // In a shadow root the path is relative to the root (":scope" is implied by querySelector on it).
  return inShadow ? parts.join(' > ') : `body ${parts.join(' > ')}`
}

/**
 * CSS.escape with a fallback.
 *
 * Chrome has always had it, but it is absent in some embedded and test DOM
 * implementations, and an unguarded call throws mid-scan - which loses the whole
 * page rather than one field.
 */
export function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`)
}
