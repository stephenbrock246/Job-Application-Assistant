/**
 * Typed access to chrome.storage.local.
 *
 * Every persisted value goes through a `StorageSlot` so that reads always return
 * a defined value (falling back to a default) and so that subscribing to changes
 * is one call instead of a hand-rolled onChanged filter at each call site.
 *
 * Nothing sensitive is stored here in plain text: no Google password, no AI
 * account password. OAuth tokens are held by Chrome's identity cache, not by us.
 */

export class StorageSlot<T> {
  constructor(
    readonly key: string,
    private readonly fallback: () => T,
    /** Applied to every stored value read back, e.g. to fill in keys added by a later version. */
    private readonly normalise: (value: T) => T = (value) => value,
  ) {}

  async get(): Promise<T> {
    const stored = await chrome.storage.local.get(this.key)
    const value = stored[this.key]
    return value === undefined ? this.fallback() : this.normalise(value as T)
  }

  async set(value: T): Promise<void> {
    await chrome.storage.local.set({ [this.key]: value })
  }

  /** Read-modify-write. Not atomic across contexts, which is fine for user-driven edits. */
  async update(updater: (current: T) => T): Promise<T> {
    const next = updater(await this.get())
    await this.set(next)
    return next
  }

  async clear(): Promise<void> {
    await chrome.storage.local.remove(this.key)
  }

  /** Fires whenever this key changes in any extension context. Returns an unsubscribe fn. */
  subscribe(handler: (value: T) => void): () => void {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => {
      if (areaName !== 'local') return
      const change = changes[this.key]
      if (!change) return
      handler(
        change.newValue === undefined ? this.fallback() : this.normalise(change.newValue as T),
      )
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }
}

export function defineSlot<T>(
  key: string,
  fallback: () => T,
  normalise?: (value: T) => T,
): StorageSlot<T> {
  return new StorageSlot<T>(key, fallback, normalise)
}
