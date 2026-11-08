/**
 * Persisting a FileSystemFileHandle across side panel reloads.
 *
 * Handles are structured-cloneable, so IndexedDB can store them - but the
 * *permission* attached to one does not survive a browser restart. The user has to
 * re-grant it with a gesture, which is why `getStoredHandle` reports the permission
 * state rather than pretending the handle is usable.
 */

const DB_NAME = 'jobapply-assistant'
const STORE = 'file-handles'
const KEY = 'csv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'))
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = operation(transaction.objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
    })
  } finally {
    db.close()
  }
}

export async function storeHandle(handle: FileSystemFileHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, KEY))
}

export async function clearHandle(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(KEY))
}

export interface StoredHandle {
  handle: FileSystemFileHandle
  /** 'granted' means we can write without prompting. */
  permission: PermissionState
}

export async function getStoredHandle(): Promise<StoredHandle | null> {
  try {
    const handle = await withStore<FileSystemFileHandle | undefined>('readonly', (store) =>
      store.get(KEY),
    )
    if (!handle) return null

    const permission = await queryPermission(handle)
    return { handle, permission }
  } catch {
    return null
  }
}

async function queryPermission(handle: FileSystemFileHandle): Promise<PermissionState> {
  const queryable = handle as FileSystemFileHandle & {
    queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  }
  if (typeof queryable.queryPermission !== 'function') return 'prompt'
  try {
    return await queryable.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'prompt'
  }
}

/** Must be called from a user gesture. */
export async function requestWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const requestable = handle as FileSystemFileHandle & {
    requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  }
  if (typeof requestable.requestPermission !== 'function') return false
  try {
    return (await requestable.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && 'showOpenFilePicker' in window
}
