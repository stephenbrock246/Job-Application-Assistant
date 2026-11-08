/**
 * Job identity by URL.
 *
 * Two links are the same job when they differ only in noise: scheme, "www.",
 * letter case of the host, a trailing slash, the #fragment, or tracking
 * parameters. Parameters that identify the job (Greenhouse `gh_jid`, Indeed `jk`,
 * LinkedIn `currentJobId`...) are kept, because on those sites the query *is* the job.
 */

const TRACKING = /^(utm_.*|gh_src|source|src|ref|refid|trk|trkinfo|lever-source.*|lever-origin|fbclid|gclid|mc_.*|_hs.*|hsa_.*)$/i

export function jobUrlKey(href: string): string {
  let url: URL
  try {
    url = new URL(href.trim())
  } catch {
    return href.trim().toLowerCase()
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.replace(/\/+$/, '')
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join('&')
  return `${host}${path}${params ? `?${params}` : ''}`
}

export function sameJobUrl(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b) && jobUrlKey(a!) === jobUrlKey(b!)
}

/**
 * Whether a newly extracted posting is a different job from the one extracted
 * before. Re-scanning the same posting (same link, or near-identical text) is not.
 */
export function isDifferentPosting(
  previous: { url?: string; title: string; description: string },
  next: { url?: string; title: string; description: string },
): boolean {
  if (previous.url && next.url && sameJobUrl(previous.url, next.url)) return false
  const similarity = wordSimilarity(previous.description, next.description)
  if (similarity >= 0.8) return false
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return similarity < 0.5 || norm(previous.title) !== norm(next.title)
}

function wordSimilarity(a: string, b: string): number {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
  const left = words(a)
  const right = words(b)
  if (!left.size && !right.size) return 1
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}
