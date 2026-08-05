'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Refresca la bandeja mientras haya comprobantes en extracción. Se apaga
 * solo cuando no queda ninguno: no tiene sentido hacer polling contra la
 * base cada 3 segundos con la bandeja quieta.
 */
export function RefrescoAutomatico({ procesando }: { procesando: number }) {
  const router = useRouter()

  useEffect(() => {
    if (procesando === 0) return
    const t = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(t)
  }, [procesando, router])

  return null
}
