'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Refresca la pantalla de revisión mientras la extracción está en curso.
 * Se monta solo mientras el estado es `procesando` (lo decide la página);
 * en cuanto el worker termina y el server component vuelve a renderizar
 * con otro estado, este componente deja de montarse y el polling se apaga
 * solo -- no hace falta ninguna condición de corte acá.
 */
export function RefrescoProcesando() {
  const router = useRouter()

  useEffect(() => {
    const t = setInterval(() => router.refresh(), 3000)
    return () => clearInterval(t)
  }, [router])

  return null
}
