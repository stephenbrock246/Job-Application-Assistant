/**
 * API credentials, one per automatic provider.
 *
 * An API key is a secret, so by default it lives in chrome.storage.session - memory
 * only, gone when Chrome closes. "Remember on this computer" moves it to
 * chrome.storage.local, which persists unencrypted in the browser profile; the
 * Settings screen says so.
 *
 * Account passwords are never stored anywhere - an API key is not a password and
 * can be revoked on its own.
 */

export type CredentialName = 'openai' | 'gemini' | 'humangpt'

const KEYS: Record<CredentialName, string> = {
  openai: 'openaiApiKey',
  gemini: 'geminiApiKey',
  humangpt: 'humangptApiKey',
}

export async function getApiKey(name: CredentialName): Promise<string | null> {
  const key = KEYS[name]
  const session = await chrome.storage.session.get(key)
  if (typeof session[key] === 'string' && session[key]) return session[key] as string
  const local = await chrome.storage.local.get(key)
  return typeof local[key] === 'string' && local[key] ? (local[key] as string) : null
}

export async function isApiKeyRemembered(name: CredentialName): Promise<boolean> {
  const key = KEYS[name]
  const local = await chrome.storage.local.get(key)
  return typeof local[key] === 'string' && Boolean(local[key])
}

export async function setApiKey(name: CredentialName, apiKey: string, remember: boolean): Promise<void> {
  const key = KEYS[name]
  const trimmed = apiKey.trim()
  await chrome.storage.session.set({ [key]: trimmed })
  if (remember) await chrome.storage.local.set({ [key]: trimmed })
  else await chrome.storage.local.remove(key)
}

export async function clearApiKey(name: CredentialName): Promise<void> {
  const key = KEYS[name]
  await chrome.storage.session.remove(key)
  await chrome.storage.local.remove(key)
}
