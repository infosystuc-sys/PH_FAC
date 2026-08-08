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
      // Ctrl+Enter y Ctrl+O van primero, sin el guard de estaEditando(): el
      // operador tiene el foco en un campo de texto casi todo el tiempo
      // mientras revisa, y ningun navegador ni sistema operativo escribe un
      // caracter literal cuando Ctrl esta apretado -- a diferencia de j/k,
      // que si tienen que respetar el foco para no robarle texto tipeado.
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

      if (estaEditando()) return

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
