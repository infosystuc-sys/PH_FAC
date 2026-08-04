'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { ORDEN_TABS, type ClaveTab } from '@/lib/estados'
import type { Conteos } from '@/server/app/comprobantes'
import styles from './filtros.module.css'

export function Filtros({ filtro, query, conteos }: {
  filtro: ClaveTab
  query: string
  conteos: Conteos
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [texto, setTexto] = useState(query)
  const [, startTransition] = useTransition()

  function navegar(next: URLSearchParams) {
    startTransition(() => router.replace(`/comprobantes?${next.toString()}`))
  }

  useEffect(() => {
    if (texto === query) return
    const t = setTimeout(() => {
      const next = new URLSearchParams(params.toString())
      if (texto) next.set('q', texto)
      else next.delete('q')
      navegar(next)
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto])

  function cambiarFiltro(clave: ClaveTab) {
    const next = new URLSearchParams(params.toString())
    if (clave === 'todos') next.delete('filtro')
    else next.set('filtro', clave)
    navegar(next)
  }

  return (
    <div className={styles.fila}>
      {ORDEN_TABS.map((t) => {
        const activo = t.clave === filtro
        return (
          <button
            key={t.clave}
            type="button"
            onClick={() => cambiarFiltro(t.clave)}
            className={activo ? `${styles.tab} ${styles.tabActivo}` : styles.tab}
          >
            {t.label}
            <span className={activo ? styles.countActivo : styles.count}>
              {conteos[t.clave]}
            </span>
          </button>
        )
      })}

      <div className={styles.buscador}>
        <span className={styles.lupa}>⌕</span>
        <input
          className={styles.input}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          placeholder="Buscar proveedor, CUIT o número"
        />
      </div>
    </div>
  )
}
