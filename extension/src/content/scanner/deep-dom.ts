/**
 * Shadow DOM awareness.
 *
 * Some application forms are built from web components whose inputs live inside
 * open shadow roots (SmartRecruiters' Easy Apply, Workday parts, Salesforce, many
 * design systems). document.querySelectorAll does not see into them, so the page
 * looks empty. These helpers search the document and every open shadow root.
 */

/** All matches in the document and in every open shadow root, in document order. */
export function deepQueryAll<T extends Element = Element>(selector: string, root: Document | ShadowRoot | Element = document): T[] {
  const results: T[] = []
  const visit = (scope: Document | ShadowRoot | Element) => {
    results.push(...Array.from(scope.querySelectorAll<T>(selector)))
    for (const element of scope.querySelectorAll('*')) {
      if (element.shadowRoot) visit(element.shadowRoot)
    }
  }
  visit(root)
  // A host's own matches come before its shadow content in this walk; keep it stable.
  return [...new Set(results)]
}

/** A shadow root: a document fragment with a host (no reliance on the global ShadowRoot class). */
export function isShadowRoot(node: Node): node is ShadowRoot {
  return node.nodeType === 11 && 'host' in node && Boolean((node as ShadowRoot).host)
}

/** The document or shadow root an element lives in. */
export function rootOf(element: Element): Document | ShadowRoot {
  const root = element.getRootNode()
  return isShadowRoot(root) ? root : document
}

/** The shadow host of an element inside a shadow root, else null. */
export function hostOf(element: Element): HTMLElement | null {
  const root = element.getRootNode()
  return isShadowRoot(root) ? (root.host as HTMLElement) : null
}
