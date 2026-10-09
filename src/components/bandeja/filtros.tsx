'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
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
  // El timeout del debounce puede disparar despues de que el operador ya
  // cambio de tab. Si leyera el `params` cerrado en el momento en que se
  // agendo el timeout, reconstruiria la URL a partir del filtro viejo y
  // revertiria el tab recien elegido. Por eso lee esta ref -- actualizada
  // en cada render -- en vez del `params` capturado por el closure.
  const paramsRef = useRef(params)
  paramsRef.current = params

  const [texto, setTexto] = useState(query)
  const [, startTransition] = useTransition()

  const navegar = useCallback((next: URLSearchParams) => {
    startTransition(() => router.replace(`/comprobantes?${next.toString()}`))
  }, [router, startTransition])

  useEffect(() => {
    if (texto === query) return
    const t = setTimeout(() => {
      const next = new URLSearchParams(paramsRef.current.toString())
      if (texto) next.set('q', texto)
      else next.delete('q')
      // Nueva busqueda: el resultado cambia, asi que la pagina donde estaba
      // parado el operador puede dejar de existir. Volver a la primera.
      next.delete('pagina')
      navegar(next)
    }, 250)
    return () => clearTimeout(t)
  }, [texto, query, navegar])

  function cambiarFiltro(clave: ClaveTab) {
    const next = new URLSearchParams(params.toString())
    if (clave === 'todos') next.delete('filtro')
    else next.set('filtro', clave)
    // Mismo motivo que en la busqueda: otro filtro es otro resultado, y la
    // pagina actual puede no existir mas en el.
    next.delete('pagina')
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

      {/* La conciliacion contra ARCA no es un filtro de la bandeja: es otra
          vista, con su propia ruta. Va separada de las pestanas de estado
          --una barra en el medio-- para que no parezca un estado mas
          (2026-10-09, pedido del usuario). */}
      <span className={styles.separadorTabs} />
      <Link href="/conciliacion" className={styles.tab}>
        Conciliación ARCA
      </Link>

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
