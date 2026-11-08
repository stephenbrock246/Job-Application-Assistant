import { useCallback, useEffect, useState } from 'react'
import type { StorageSlot } from '@/storage/base'

/**
 * Binds a React component to a `StorageSlot`.
 * Returns `[value, setValue, loaded]`; `value` is the slot default until the first
 * read resolves, so components never have to handle `undefined`.
 */
export function useStorageSlot<T>(slot: StorageSlot<T>, initial: T) {
  const [value, setValue] = useState<T>(initial)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void slot.get().then((stored) => {
      if (cancelled) return
      setValue(stored)
      setLoaded(true)
    })
    const unsubscribe = slot.subscribe((next) => {
      if (!cancelled) setValue(next)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [slot])

  const write = useCallback(
    async (next: T) => {
      setValue(next)
      await slot.set(next)
    },
    [slot],
  )

  return [value, write, loaded] as const
}
