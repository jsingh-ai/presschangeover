import { useEffect, useId, useRef, type ReactNode } from 'react'

interface EvidenceDrawerShellProps {
  eyebrow: string
  title: string
  context?: string
  tone?: string
  loading?: boolean
  loadingLabel?: string
  onClose(): void
  children: ReactNode
  className?: string
}

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])'

export function EvidenceDrawerShell({ eyebrow, title, context, tone = 'neutral', loading = false, loadingLabel = 'Loading evidence…', onClose, children, className = '' }: EvidenceDrawerShellProps) {
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !panel.current) return
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-hidden') !== 'true')
      if (!focusable.length) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      returnFocus.current?.focus()
    }
  }, [onClose])

  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside ref={panel} className={`investigation-side-panel evidence-drawer-shell ${className}`.trim()} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={loading || undefined}>
      <header className={`drawer-header drawer-header--${tone}`}>
        <div><p className="eyebrow">{eyebrow}</p><h2 id={titleId}>{title}</h2>{context && <span className="drawer-header-context">{context}</span>}</div>
        <button ref={closeButton} type="button" className="drawer-close" aria-label="Close investigation evidence" onClick={onClose}>×</button>
      </header>
      {loading ? <div className="drawer-loading" role="status">{loadingLabel}</div> : children}
    </aside>
  </div>
}
