/**
 * Google OAuth via chrome.identity.
 *
 * We never see or store a Google password. Chrome holds the token in its own
 * identity cache; we only cache the account email for display.
 */

import { GOOGLE } from '@/shared/constants/defaults'
import { googleAccountSlot } from '@/storage/settings'
import type { GoogleAccountInfo } from '@/shared/types/settings'

const PLACEHOLDER_CLIENT_ID = 'REPLACE_WITH_YOUR_CHROME_APP_OAUTH_CLIENT_ID'

export class GoogleAuthError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.name = 'GoogleAuthError'
    this.code = code
  }
}

function assertClientIdConfigured(): void {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.ManifestV3 & {
    oauth2?: { client_id?: string }
  }
  const clientId = manifest.oauth2?.client_id ?? ''
  if (!clientId || clientId.startsWith(PLACEHOLDER_CLIENT_ID)) {
    throw new GoogleAuthError(
      'Google OAuth client ID is not configured. See README > Google Cloud setup, then reload the extension.',
      'OAUTH_NOT_CONFIGURED',
    )
  }
}

/**
 * Gets an access token. `interactive: false` is used for silent status checks so
 * opening the side panel never pops a consent window on its own.
 */
export async function getToken(interactive: boolean): Promise<string | null> {
  assertClientIdConfigured()
  try {
    const result = await chrome.identity.getAuthToken({ interactive })
    const token = typeof result === 'string' ? result : result?.token
    return token ?? null
  } catch (error) {
    // Silent attempts fail routinely when the user has not consented yet.
    if (!interactive) return null
    const message = error instanceof Error ? error.message : String(error)
    if (/user (did not approve|cancel)/i.test(message)) {
      throw new GoogleAuthError('Google sign-in was cancelled.', 'USER_CANCELLED')
    }
    throw new GoogleAuthError(message, 'AUTH_FAILED')
  }
}

/** Drops a token Chrome has cached, so the next call fetches a fresh one. */
export async function invalidateToken(token: string): Promise<void> {
  try {
    await chrome.identity.removeCachedAuthToken({ token })
  } catch {
    /* already gone */
  }
}

export async function connect(): Promise<GoogleAccountInfo> {
  const token = await getToken(true)
  if (!token) throw new GoogleAuthError('Google sign-in did not return a token.', 'AUTH_FAILED')

  const email = await fetchEmail(token)
  const account: GoogleAccountInfo = { email, connectedAt: Date.now() }
  await googleAccountSlot.set(account)
  return account
}

export async function disconnect(): Promise<void> {
  const token = await getToken(false)
  if (token) {
    await invalidateToken(token)
    // Best-effort revoke; the local cache is already cleared either way.
    try {
      await fetch(`${GOOGLE.revoke}?token=${encodeURIComponent(token)}`, { method: 'POST' })
    } catch {
      /* offline is fine */
    }
  }
  await googleAccountSlot.clear()
}

/** Non-interactive status check for the connection card. */
export async function currentAccount(): Promise<GoogleAccountInfo | null> {
  const cached = await googleAccountSlot.get()
  if (!cached) return null
  try {
    const token = await getToken(false)
    return token ? cached : null
  } catch {
    return null
  }
}

async function fetchEmail(token: string): Promise<string> {
  const response = await fetch(GOOGLE.userInfo, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) return ''
  const data = (await response.json()) as { email?: string }
  return data.email ?? ''
}

/**
 * Authenticated fetch that retries once after clearing a stale token.
 * Every Sheets call goes through here.
 */
export async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const attempt = async (token: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

  const token = await getToken(false)
  if (!token) {
    throw new GoogleAuthError(
      'Not signed in to Google. Connect your account from the side panel.',
      'NOT_AUTHENTICATED',
    )
  }

  let response = await attempt(token)
  if (response.status === 401) {
    await invalidateToken(token)
    const fresh = await getToken(true)
    if (!fresh) {
      throw new GoogleAuthError('Google session expired. Please reconnect.', 'NOT_AUTHENTICATED')
    }
    response = await attempt(fresh)
  }
  return response
}
