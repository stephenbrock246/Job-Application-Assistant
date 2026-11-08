/**
 * AI transport check: retries, fallback and the exclusive task lock.
 *
 * Drives the real Gemini provider against a scripted fake API (no network, no real
 * waiting - sleeps are recorded instead) and asserts the contract:
 *
 *   - transient failures (408/429/5xx, network) retry on the ~2/4/8/16/30s schedule;
 *   - configuration errors (400/401/403/404) fail at once;
 *   - attempts are bounded, with exactly one fallback attempt after repeated 503s;
 *   - the model that answered is always reported;
 *   - one logical operation cannot run twice at once.
 *
 *   npm run check:ai
 */

const failures: string[] = []
function expect(condition: boolean, message: string) {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${message}`)
  if (!condition) failures.push(message)
}

// ---------------------------------------------------------------------------
// Fake chrome.storage and fake Gemini API
// ---------------------------------------------------------------------------

const local: Record<string, unknown> = {}
const store = (data: Record<string, unknown>) => ({
  get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
  set: async (items: Record<string, unknown>) => void Object.assign(data, items),
  remove: async (key: string) => void delete data[key],
})
;(globalThis as Record<string, unknown>).chrome = {
  storage: {
    session: store({ geminiApiKey: 'test-key' }),
    local: store(local),
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}

type Scripted = number | 'network' | 'hang' | { status: number; retryDelay?: string }
let script: Scripted[] = []
let calls: string[] = []

globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const model = decodeURIComponent(/models\/([^:]+):/.exec(url)?.[1] ?? '?')
  calls.push(model)
  const next = script.shift() ?? 200
  if (next === 'network') throw new TypeError('Failed to fetch')
  if (next === 'hang') {
    // A request that never answers - until it is aborted, like a real fetch.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  }
  const status = typeof next === 'number' ? next : next.status
  if (status === 200) {
    return new Response(
      JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: `answer from ${model}` }] } }] }),
      { status: 200 },
    )
  }
  const details = typeof next === 'object' && next.retryDelay
    ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: next.retryDelay }]
    : []
  const message = status === 400 ? 'API key not valid. Please pass a valid API key.' : 'This model is currently experiencing high demand.'
  return new Response(JSON.stringify({ error: { message, details } }), { status })
}) as typeof fetch

const { GeminiApiProvider } = await import('../extension/src/ai/gemini.provider.ts')
const { withRetry, AIHttpError, AICancelledError } = await import('../extension/src/ai/retry.ts')
const { runExclusive, isRunning, TaskBusyError, cancelTask } = await import('../extension/src/sidepanel/lib/ai-activity.ts')
import type { AIEvent } from '../extension/src/shared/types/ai.ts'

let sleeps: number[] = []
const provider = new GeminiApiProvider({ sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 })

async function run(sequence: Scripted[]) {
  script = [...sequence]
  calls = []
  sleeps = []
  const events: AIEvent[] = []
  try {
    const reply = await provider.complete('Tailor my resume', { onEvent: (e) => events.push(e) })
    return { reply, error: null as Error | null, events }
  } catch (error) {
    return { reply: null, error: error as Error, events }
  }
}

// ---------------------------------------------------------------------------

console.log('\n--- Transient failures retry with backoff -----------------------\n')

let r = await run([503, 503, 200])
expect(r.reply === 'answer from gemini-3.8-flash', 'succeeds after two 503s')
expect(sleeps.join() === '2000,4000', `waits ~2s then ~4s (${sleeps.join()})`)
const retries = r.events.filter((e) => e.type === 'retry')
expect(
  retries.length === 2 && retries[1]!.type === 'retry' && retries[1]!.attempt === 2 && retries[1]!.maxRetries === 5,
  'reports "retrying (2/5)" progress',
)
expect(
  r.events.some((e) => e.type === 'done' && e.model === 'gemini-3.8-flash' && !e.fallback),
  'reports the model that answered',
)

for (const status of [408, 429, 500, 502, 504]) {
  r = await run([status, 200])
  expect(r.reply !== null && calls.length === 2, `HTTP ${status} is retried`)
}

r = await run(['network', 200])
expect(r.reply !== null && calls.length === 2, 'a dropped connection is retried')

r = await run([{ status: 429, retryDelay: '37s' }, 200])
expect(sleeps[0] === 37_000, `Google's suggested retry delay is honoured (${sleeps[0]}ms)`)

console.log('\n--- Configuration errors fail at once --------------------------\n')

for (const status of [400, 401, 403, 404]) {
  r = await run([status, 200])
  expect(r.error !== null && calls.length === 1 && sleeps.length === 0, `HTTP ${status} is not retried (${calls.length} call)`)
}
r = await run([400])
expect(Boolean(r.error?.message.includes('rejected the API key')), 'a bad key says so plainly')

console.log('\n--- Bounded attempts and one fallback --------------------------\n')

r = await run([503, 503, 503, 503, 503, 503, 200])
expect(sleeps.join() === '2000,4000,8000,16000,30000', `full schedule used before giving up on the primary (${sleeps.join()})`)
expect(calls.length === 7 && calls[6] === 'gemini-2.5-flash', `6 primary attempts, then exactly 1 on the fallback (${calls.join(' > ')})`)
expect(r.reply === 'answer from gemini-2.5-flash', 'fallback answer is returned')
expect(
  r.events.some((e) => e.type === 'fallback' && e.from === 'gemini-3.8-flash' && e.to === 'gemini-2.5-flash'),
  'the switch to the fallback model is announced, not silent',
)
expect(r.events.some((e) => e.type === 'done' && e.model === 'gemini-2.5-flash' && e.fallback), 'result is marked as written by the fallback')

r = await run([503, 503, 503, 503, 503, 503, 503])
expect(r.error !== null && calls.length === 7, `everything down: gives up after 7 attempts total (${calls.length})`)
expect(Boolean(r.error?.message.includes('Press Retry')), `final message tells the user what to do (${r.error?.message})`)

r = await run([429, 429, 429, 429, 429, 429])
expect(r.error !== null && calls.length === 6 && !calls.includes('gemini-2.5-flash'), 'rate limiting (429) does not trigger the fallback model')

r = await run([503, 500, 500, 500, 500, 500])
expect(!calls.includes('gemini-2.5-flash'), 'a single 503 is not "repeatedly overloaded" - no fallback')

local.preferences = { geminiFallbackModel: '' }
r = await run([503, 503, 503, 503, 503, 503])
expect(r.error !== null && calls.length === 6, 'fallback switched off: stops after the primary retries')
delete local.preferences

console.log('\n--- Jitter stays in bounds -------------------------------------\n')

for (const [random, expected] of [[0, 1600], [1, 2400]] as const) {
  const waited: number[] = []
  let first = true
  await withRetry(
    async () => {
      if (first) {
        first = false
        throw new AIHttpError('busy', 503)
      }
      return 'ok'
    },
    { sleep: async (ms) => void waited.push(ms), random: () => random },
  )
  expect(waited[0] === expected, `jitter ${random === 0 ? 'low' : 'high'} end: ${waited[0]}ms (2s +-20%)`)
}

console.log('\n--- One operation at a time ------------------------------------\n')

let release!: () => void
const first = runExclusive('s1:resume', 'Tailoring...', () => new Promise<void>((resolve) => (release = resolve)))
expect(isRunning('s1:resume'), 'the operation holds its lock while running')

let blocked = false
try {
  await runExclusive('s1:resume', 'again', async () => undefined)
} catch (error) {
  blocked = error instanceof TaskBusyError
}
expect(blocked, 'a second run of the same operation is refused, not queued')

let otherRan = false
await runExclusive('s1:coverLetter', 'x', async () => void (otherRan = true))
expect(otherRan, 'a different operation is not blocked')

release()
await first
expect(!isRunning('s1:resume'), 'the lock is released when the operation ends')

let releasedOnError = false
try {
  await runExclusive('s2:resume', 'x', async () => {
    throw new Error('boom')
  })
} catch {
  releasedOnError = !isRunning('s2:resume')
}
expect(releasedOnError, 'the lock is released when the operation fails')

console.log('\n--- Cancel ------------------------------------------------------\n')

// Real (cancellable) waits here, with a long schedule, so a cancel must cut them short.
const slowRetries = new GeminiApiProvider({ delaysMs: [30_000, 30_000], random: () => 0.5 })

script = [503, 200]
calls = []
let controller = new AbortController()
let startedAt = Date.now()
setTimeout(() => controller.abort(), 100)
let cancelError: unknown = null
try {
  await slowRetries.complete('x', { signal: controller.signal })
} catch (error) {
  cancelError = error
}
expect(cancelError instanceof AICancelledError, 'Cancel during a retry wait ends it with "cancelled", not an error message')
expect(Date.now() - startedAt < 2_000 && calls.length === 1, `the 30s wait was cut short and no further attempt was made (${Date.now() - startedAt}ms, ${calls.length} call)`)

script = ['hang']
calls = []
controller = new AbortController()
startedAt = Date.now()
setTimeout(() => controller.abort(), 100)
cancelError = null
try {
  await slowRetries.complete('x', { signal: controller.signal })
} catch (error) {
  cancelError = error
}
expect(cancelError instanceof AICancelledError, 'Cancel aborts a request that is still waiting for Gemini')
expect(calls.length === 1, 'an aborted request is not retried or treated as a timeout')

let sawSignal: AbortSignal | null = null
const cancellable = runExclusive('s3:resume', 'Tailoring...', (_report, signal) => {
  sawSignal = signal
  return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new AICancelledError())))
})
cancelTask('s3:resume')
let registryCancelled = false
try {
  await cancellable
} catch (error) {
  registryCancelled = error instanceof AICancelledError
}
expect(registryCancelled && (sawSignal as AbortSignal | null)?.aborted === true, "the panel's Cancel reaches the running task's signal")
expect(!isRunning('s3:resume'), 'after Cancel the operation can be started again (Retry)')

console.log('\n--- Humanizer removed ---------------------------------------------\n')

const { humanizeAnswer } = await import('../extension/src/resume/cover-letter.ts')
// An install that had HumanGPT switched on: the setting reads as off, nothing is sent.
local.preferences = { humanizerEnabled: true, humanizerMode: 'light' }
let humanCalled = false
globalThis.fetch = (async () => {
  humanCalled = true
  return new Response('{}')
}) as typeof fetch
const humanSession = { id: 's9', company: 'Stripe', position: 'Backend Engineer' } as unknown as Parameters<typeof humanizeAnswer>[0]
const draft = { fieldId: 'f1', question: 'Why us?', text: 'I have built payment APIs for five years.', warnings: [], generatedAt: 1 }
const off = await humanizeAnswer(humanSession, draft)
expect(!humanCalled && off.text === draft.text, 'a saved "humanizer on" setting no longer sends anything to HumanGPT')
console.log('')
if (failures.length) {
  console.error(`${failures.length} AI check(s) failed.\n`)
  process.exit(1)
}
console.log('All AI checks passed.\n')
