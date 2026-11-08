import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Icon, TextArea } from './ui'

interface AskOptions {
  title: string
  message?: string
  confirmLabel?: string
  tone?: 'primary' | 'success' | 'danger'
  /** Shows a text box; the promise resolves with its text (or null when cancelled). */
  input?: { placeholder?: string }
}

/**
 * In-panel replacement for window.confirm / window.prompt, which look foreign in
 * the side panel and block the whole page.
 *
 *   const [dialog, ask] = useDialog()
 *   if (await ask({ title: 'Submit?' })) ...      // confirm: true / false
 *   const note = await ask({ title: 'Note', input: {} })  // prompt: string / null
 */
export function useDialog(): [ReactNode, (options: AskOptions) => Promise<string | boolean | null>] {
  const [open, setOpen] = useState<AskOptions | null>(null)
  const [text, setText] = useState('')
  const resolver = useRef<((value: string | boolean | null) => void) | null>(null)

  const ask = useCallback((options: AskOptions) => {
    resolver.current?.(options.input ? null : false)
    setText('')
    setOpen(options)
    return new Promise<string | boolean | null>((resolve) => (resolver.current = resolve))
  }, [])

  const close = (value: string | boolean | null) => {
    resolver.current?.(value)
    resolver.current = null
    setOpen(null)
  }

  const element = open ? (
    <Modal title={open.title} onClose={() => close(open.input ? null : false)}>
      <div className="space-y-3">
        {open.message && <p className="text-xs leading-relaxed text-slate-600">{open.message}</p>}
        {open.input && (
          <TextArea rows={3} autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder={open.input.placeholder} />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => close(open.input ? null : false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            autoFocus={!open.input}
            variant={open.tone === 'danger' ? 'danger' : open.tone === 'success' ? 'success' : 'primary'}
            onClick={() => close(open.input ? text : true)}
          >
            {open.confirmLabel ?? 'OK'}
          </Button>
        </div>
      </div>
    </Modal>
  ) : null

  return [element, ask]
}

/** Simple centred overlay. The side panel is narrow, so modals are near full-width. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-3"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-sm animate-fade-in rounded-xl bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
          <h3 className="text-[13px] font-semibold text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <Icon name="close" className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  )
}
