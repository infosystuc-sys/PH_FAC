'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

function estaEditando(): boolean {
  const activo = document.activeElement
  if (!activo) return false
  const tag = activo.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function useAtajos({
  onConfirmar,
  onObservar,
  anteriorHref,
  siguienteHref,
}: {
  onConfirmar: () => void
  onObservar: () => void
  anteriorHref: string | null
  siguienteHref: string | null
}) {
  const router = useRouter()

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (estaEditando()) return

      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault()
        onConfirmar()
        return
      }
      if (e.ctrlKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault()
        onObservar()
        return
      }
      if (e.key === 'j' || e.key === 'J' || e.key === 'ArrowDown') {
        if (siguienteHref) router.push(siguienteHref)
        return
      }
      if (e.key === 'k' || e.key === 'K' || e.key === 'ArrowUp') {
        if (anteriorHref) router.push(anteriorHref)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onConfirmar, onObservar, anteriorHref, siguienteHref, router])
}
