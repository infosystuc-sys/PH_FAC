'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import styles from './paginacion.module.css'

export function Paginacion({
  pagina,
  totalPaginas,
  desde,
  hasta,
  total,
}: {
  pagina: number
  totalPaginas: number
  desde: number
  hasta: number
  total: number
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [, startTransition] = useTransition()

  function irA(p: number) {
    const next = new URLSearchParams(params.toString())
    if (p <= 1) next.delete('pagina')
    else next.set('pagina', String(p))
    startTransition(() => router.replace(`/comprobantes?${next.toString()}`))
  }

  return (
    <div className={styles.fila}>
      <span className={styles.texto}>
        {total === 0 ? '0 comprobantes' : `Mostrando ${desde}-${hasta} de ${total} comprobantes`}
      </span>

      {totalPaginas > 1 && (
        <div className={styles.controles}>
          <button
            type="button"
            className={styles.boton}
            onClick={() => irA(pagina - 1)}
            disabled={pagina <= 1}
          >
            ‹ Anterior
          </button>
          <span className={styles.indicador}>
            Página {pagina} de {totalPaginas}
          </span>
          <button
            type="button"
            className={styles.boton}
            onClick={() => irA(pagina + 1)}
            disabled={pagina >= totalPaginas}
          >
            Siguiente ›
          </button>
        </div>
      )}
    </div>
  )
}
