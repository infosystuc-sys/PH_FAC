'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { buscarArticulosTango, elegirArticulo } from '@/server/app/acciones'
import type { ArticuloTango } from '@/server/tango/articulos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './selector-articulo.module.css'

/**
 * Corrige a mano el artículo de un renglón cuando el emparejamiento
 * automático contra el remito se equivocó.
 *
 * Arranca cerrado: la mayoría de los renglones están bien y un buscador
 * abierto en cada uno sería ruido en una tarjeta que puede tener 48 filas.
 *
 * Mismo patrón que `SelectorProveedor`: debounce de 250 ms y una bandera
 * `vigente` por corrida del efecto, para que una respuesta lenta de una
 * búsqueda vieja no pise los resultados de la nueva.
 */
export function SelectorArticulo({
  comprobanteId,
  renglonId,
  codigoActual,
  corregido,
}: {
  comprobanteId: number
  renglonId: number
  codigoActual: string | null
  /** Si el código que se muestra ya viene de una corrección manual. */
  corregido: boolean
}) {
  const [abierto, setAbierto] = useState(false)
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<ArticuloTango[]>([])
  const [buscando, setBuscando] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const toast = useToast()

  useEffect(() => {
    clearTimeout(debounce.current)
    if (!abierto || query.trim().length < 2) {
      setResultados([])
      setBuscando(false)
      return
    }
    let vigente = true
    setBuscando(true)
    debounce.current = setTimeout(() => {
      buscarArticulosTango(query)
        .then((r) => {
          if (!vigente) return
          setResultados(r)
          setBuscando(false)
        })
        .catch(() => vigente && setBuscando(false))
    }, 250)
    return () => {
      vigente = false
      clearTimeout(debounce.current)
    }
  }, [query, abierto])

  function elegir(cod: string | null) {
    arrancar(async () => {
      try {
        await elegirArticulo(comprobanteId, renglonId, cod)
        setAbierto(false)
        setQuery('')
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo cambiar el artículo.')
      }
    })
  }

  if (!abierto) {
    return (
      <button type="button" className={styles.abrir} onClick={() => setAbierto(true)}>
        {corregido ? 'Cambiar artículo ·' : 'Cambiar artículo'}
        {corregido && <span className={styles.corregido}>corregido a mano</span>}
      </button>
    )
  }

  return (
    <div className={styles.panel}>
      <input
        className={styles.buscador}
        autoFocus
        value={query}
        placeholder="Código de barras, código de artículo o descripción"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setAbierto(false)}
      />

      {query.trim().length >= 2 && (
        <ul className={styles.resultados}>
          {buscando && <li className={styles.vacio}>Buscando…</li>}
          {!buscando && resultados.length === 0 && (
            <li className={styles.vacio}>Ningún artículo coincide.</li>
          )}
          {resultados.map((a) => (
            <li key={a.codArticu}>
              <button
                type="button"
                className={styles.resultado}
                disabled={pendiente}
                onClick={() => elegir(a.codArticu)}
              >
                <span className={styles.codigo}>{a.codArticu}</span>
                <span className={styles.desc}>
                  {a.descripcion}
                  {a.descAdic && ` · ${a.descAdic}`}
                </span>
                {/* Por que campo se encontro: un match por descripcion es
                    mucho mas debil que uno por codigo de barras, y el
                    operador tiene que poder desconfiar del segundo. */}
                <span className={styles.porQue}>{a.porQue}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={styles.acciones}>
        <button type="button" className={styles.cancelar} onClick={() => setAbierto(false)}>
          Cancelar
        </button>
        {corregido && (
          <button
            type="button"
            className={styles.descartar}
            disabled={pendiente}
            onClick={() => elegir(null)}
          >
            Volver al automático
          </button>
        )}
      </div>
    </div>
  )
}
