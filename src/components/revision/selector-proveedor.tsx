'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { buscarProveedores, elegirProveedor } from '@/server/app/acciones'
import type { Proveedor } from '@/server/tango/proveedores'
import { formatCuit } from '@/lib/formato'
import styles from './selector-proveedor.module.css'

export function SelectorProveedor({
  comprobanteId,
  candidatos,
}: {
  comprobanteId: number
  candidatos: Proveedor[]
}) {
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<Proveedor[]>([])
  const [pendiente, arrancar] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    clearTimeout(debounce.current)
    if (query.trim().length < 2) {
      setResultados([])
      return
    }
    let vigente = true
    debounce.current = setTimeout(() => {
      buscarProveedores(query).then((r) => {
        if (vigente) setResultados(r)
      })
    }, 250)
    return () => {
      vigente = false
      clearTimeout(debounce.current)
    }
  }, [query])

  function elegir(p: Proveedor, corregido: boolean) {
    arrancar(async () => {
      await elegirProveedor(comprobanteId, p.codProvee, p.razonSocial, corregido)
    })
  }

  return (
    <div className={styles.selector}>
      {candidatos.length > 0 && (
        <ul className={styles.candidatos}>
          {candidatos.map((p) => (
            <li key={p.codProvee}>
              <button type="button" disabled={pendiente} onClick={() => elegir(p, false)} className={styles.candidato}>
                <span className={styles.razon}>{p.razonSocial}</span>
                <span className={styles.detalle}>{p.codProvee} · {formatCuit(p.cuit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="text"
        className={styles.buscador}
        placeholder="Buscar proveedor por razón social…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {resultados.length > 0 && (
        <ul className={styles.candidatos}>
          {resultados.map((p) => (
            <li key={p.codProvee}>
              <button type="button" disabled={pendiente} onClick={() => elegir(p, true)} className={styles.candidato}>
                <span className={styles.razon}>{p.razonSocial}</span>
                <span className={styles.detalle}>{p.codProvee} · {formatCuit(p.cuit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
