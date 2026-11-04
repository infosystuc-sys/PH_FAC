'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { buscarArticulosTango } from '@/server/app/acciones/articulos'
import type { ArticuloTango } from '@/server/tango/articulos'
import styles from './buscador-articulos.module.css'
import { Icono } from '@/components/icono'

/**
 * La ventana para buscar un artículo en Tango (2026-10-08, pedido del
 * usuario). Reemplaza al buscador en línea, que mostraba código y
 * descripción y nada más: acá entran las cuatro llaves por las que el
 * operador puede reconocer un artículo --código, descripción, descripción
 * adicional y sinónimo-- en columnas, para poder compararlas.
 *
 * La consulta ya las cubría todas (`buscarArticulos`); lo que faltaba era
 * mostrarlas. Busca además por código de barras y por el código con el que
 * ESTE proveedor llama al artículo (`CPA15.COD_SINONI`), que es la llave
 * pensada para esto y por eso ordena primero.
 */
export function BuscadorArticulos({
  codProvee,
  descripcionFactura,
  onElegir,
  onCerrar,
}: {
  codProvee: string | null
  /** Lo que imprime la factura: es contra lo que el operador compara. */
  descripcionFactura: string
  onElegir: (codArticu: string) => void
  onCerrar: () => void
}) {
  const [query, setQuery] = useState('')
  const [resultados, setResultados] = useState<ArticuloTango[]>([])
  const [buscando, setBuscando] = useState(false)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const caja = useRef<HTMLDivElement>(null)

  // Escape cierra. Es lo que espera cualquiera en una ventana modal, y acá
  // importa más que en otras: el operador la abre, mira y la cierra muchas
  // veces por comprobante.
  useEffect(() => {
    const alTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCerrar()
    }
    document.addEventListener('keydown', alTecla)
    return () => document.removeEventListener('keydown', alTecla)
  }, [onCerrar])

  useEffect(() => {
    clearTimeout(debounce.current)
    if (query.trim().length < 2) {
      setResultados([])
      setBuscando(false)
      return
    }
    let vigente = true
    setBuscando(true)
    debounce.current = setTimeout(() => {
      buscarArticulosTango(query, codProvee)
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
  }, [query, codProvee])

  const elegir = useCallback(
    (codArticu: string) => {
      onElegir(codArticu)
      onCerrar()
    },
    [onElegir, onCerrar],
  )

  return (
    <div
      className={styles.fondo}
      // Cerrar al clickear afuera, pero no cuando el click empezo adentro y
      // termino en el borde (seleccionar texto, por ejemplo).
      onMouseDown={(e) => {
        if (!caja.current?.contains(e.target as Node)) onCerrar()
      }}
    >
      <div className={styles.caja} ref={caja} role="dialog" aria-modal="true" aria-label="Buscar artículo en Tango">
        <div className={styles.encabezado}>
          <div>
            <p className={styles.titulo}>Buscar artículo en Tango</p>
            {/* Lo que dice la factura, siempre a la vista: es el dato
                contra el que se elige, y si hay que ir a buscarlo a la
                pantalla de atras la ventana estorba en vez de ayudar. */}
            <p className={styles.deLaFactura}>
              La factura dice: <span className={styles.mono}>{descripcionFactura}</span>
            </p>
          </div>
          <button type="button" className={styles.cerrar} onClick={onCerrar} aria-label="Cerrar">
            <Icono nombre="x" size={15} />
          </button>
        </div>

        <input
          className={styles.busqueda}
          type="text"
          autoFocus
          placeholder="Código, descripción, descripción adicional o sinónimo…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className={styles.resultados}>
          {query.trim().length < 2 && (
            <p className={styles.nota}>Escribí al menos dos caracteres.</p>
          )}
          {buscando && <p className={styles.nota}>Buscando…</p>}
          {!buscando && query.trim().length >= 2 && resultados.length === 0 && (
            <p className={styles.nota}>Ningún artículo coincide.</p>
          )}
          {resultados.length > 0 && (
            <table className={styles.tabla}>
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Descripción</th>
                  <th>Descripción adicional</th>
                  <th>Sinónimo</th>
                  <th>Coincide por</th>
                </tr>
              </thead>
              <tbody>
                {resultados.map((a) => (
                  <tr
                    key={a.codArticu}
                    className={styles.fila}
                    onClick={() => elegir(a.codArticu)}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        elegir(a.codArticu)
                      }
                    }}
                  >
                    <td className={styles.mono}>{a.codArticu}</td>
                    <td>{a.descripcion}</td>
                    <td>{a.descAdic ?? ''}</td>
                    <td className={styles.mono}>{a.sinonimo ?? ''}</td>
                    <td className={styles.porQue}>{a.porQue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className={styles.pie}>
          Se busca por código de artículo, descripción, descripción adicional, sinónimo, código de
          barras y el código con el que este proveedor lo llama. Clic en una fila para elegirlo.
        </p>
      </div>
    </div>
  )
}
