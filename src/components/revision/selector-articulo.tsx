'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { buscarArticulosTango, elegirArticulo } from '@/server/app/acciones/articulos'
import { asignarRemito } from '@/server/app/acciones/remitos'
import type { ArticuloTango } from '@/server/tango/articulos'
import type { RemitoPendiente } from '@/server/tango/remitos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './selector-articulo.module.css'

/**
 * Corrige a mano a qué apunta un renglón cuando el emparejamiento
 * automático se equivocó. Dos caminos, en el orden en que conviene
 * intentarlos:
 *
 * 1. Los renglones del remito que todavía tienen saldo. Es lo más probable
 *    y lo único que conserva el vínculo con Tango, así que van primero y
 *    sin necesidad de buscar nada.
 * 2. El maestro de artículos completo, por si lo que la factura cobra no
 *    está en ningún remito.
 *
 * Reemplaza al panel "Remitos pendientes", que hacía lo primero en una
 * tarjeta aparte: repetía la información de "Renglones detectados" y
 * ocupaba más pantalla que los renglones mismos.
 *
 * Arranca cerrado: la mayoría de los renglones están bien y un selector
 * abierto en cada uno sería ruido en una tarjeta que puede tener 48 filas.
 *
 * Mismo patrón que `SelectorProveedor`: debounce de 250 ms y una bandera
 * `vigente` por corrida del efecto, para que una respuesta lenta de una
 * búsqueda vieja no pise los resultados de la nueva.
 */
export function SelectorArticulo({
  comprobanteId,
  renglonId,
  corregido,
  remitos,
  yaAsignados,
  remitoActual,
  codProvee,
}: {
  comprobanteId: number
  renglonId: number
  /** Si el código que se muestra ya viene de una corrección manual. */
  corregido: boolean
  /** Los remitos con saldo del proveedor, para ofrecer sus renglones. */
  remitos: RemitoPendiente[]
  /** Claves "interno-renglón" ya tomadas por otro renglón de la factura. */
  yaAsignados: Set<string>
  /** La clave del renglón de remito al que apunta este, si apunta a alguno. */
  remitoActual: string | null
  /** El proveedor del comprobante, para buscar artículos. */
  codProvee: string | null
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
  }, [query, abierto, codProvee])

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

  function asignar(
    ncompInS: string | null,
    nRenglon: number | null,
    numero: string | null,
    cantidad: number | null,
  ) {
    arrancar(async () => {
      try {
        await asignarRemito(comprobanteId, renglonId, ncompInS, nRenglon, numero, cantidad)
        setAbierto(false)
        setQuery('')
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo cambiar el renglón del remito.')
      }
    })
  }

  // Todos los renglones del remito, incluidos los que ya se llevo otro
  // renglon de la factura. Ocultarlos parecia mas prolijo pero rompe el caso
  // mas comun: si el modelo intercambio dos talles, los dos estan tomados y
  // no habria a que reapuntar. Se marcan como ocupados y se dejan elegir --
  // el cotejo detecta el duplicado y el que quedo huerfano, asi que el
  // operador ve enseguida que le falta arreglar la otra fila.
  const delRemito = remitos.flatMap((remito) =>
    remito.renglones.map((rr) => {
      const clave = `${remito.numeroInterno}-${rr.nRenglon}`
      return {
        remito,
        rr,
        clave,
        ocupado: clave !== remitoActual && yaAsignados.has(clave),
      }
    }),
  )

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
      {delRemito.length > 0 && (
        <ul className={styles.resultados}>
          {delRemito.map(({ remito, rr, clave, ocupado }) => (
            <li key={clave}>
              <button
                type="button"
                className={`${styles.resultado} ${clave === remitoActual ? styles.elegido : ''} ${
                  ocupado ? styles.ocupado : ''
                }`}
                disabled={pendiente}
                onClick={() =>
                  asignar(remito.numeroInterno, rr.nRenglon, remito.numero, rr.cantidadPendiente)
                }
              >
                <span className={styles.codigo}>{rr.codArticulo}</span>
                <span className={styles.desc}>{rr.descripcion ?? 'sin descripción'}</span>
                <span className={styles.porQue}>
                  {ocupado ? 'ya asignado' : `remito · pend. ${rr.cantidadPendiente}`}
                </span>
              </button>
            </li>
          ))}
          {remitoActual !== null && (
            <li>
              <button
                type="button"
                className={styles.resultado}
                disabled={pendiente}
                onClick={() => asignar(null, null, null, null)}
              >
                <span className={styles.codigo}>—</span>
                <span className={styles.desc}>Sin remito</span>
                <span className={styles.porQue} />
              </button>
            </li>
          )}
        </ul>
      )}

      <input
        className={styles.buscador}
        autoFocus
        value={query}
        placeholder="…o buscá en todo Tango: código de barras, código o descripción"
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
