'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { listarSeriesRemito, guardarSeriesRenglon } from '@/server/app/acciones/remitos'
import type { RenglonConSerie } from '@/server/app/series'
import { LARGO_SERIE, type Serie } from '@/lib/series'
import { formatCantidad } from '@/lib/formato'
import { useToast } from '@/components/toast/toast-provider'
import styles from './series-remito.module.css'

const VACIA: Serie = { nSerie: '', desc1: '', desc2: '', comentario: '' }

/** Una fila por unidad: lo guardado y, si falta, filas vacías hasta la cantidad. */
function filasDe(r: RenglonConSerie): Serie[] {
  const unidades = Number.isInteger(r.cantidad) && r.cantidad > 0 ? r.cantidad : r.series.length
  const filas = r.series.map((s) => ({ ...s }))
  while (filas.length < unidades) filas.push({ ...VACIA })
  return filas
}

/**
 * Los números de serie de un remito (2026-11-04, pedido del usuario).
 *
 * Aparece solo si algún renglón es de un artículo que usa número de serie
 * en Tango (`STA11.USA_SERIE`): uno por unidad, con las dos descripciones y
 * el comentario que Tango guarda junto a cada serie. En las motos son el
 * chasis, el motor, el color y el DNRPA, que es como se llama acá el
 * comentario (2026-11-05). Al registrar van a `STA07` y `STA06`. Sin las
 * series completas, "Listo para registrar" bloquea.
 *
 * Si el proveedor tiene regla de series (seriesProveedor.ts, hoy IMSA), las
 * series vienen leídas del comprobante: el operador las revisa contra el
 * PDF, carga el DNRPA y guarda.
 */
export function SeriesRemito({
  comprobanteId,
  renglonesClave,
  soloLectura = false,
  version = 0,
}: {
  comprobanteId: number
  /** Cambia cuando cambian los renglones (otra OC, otro artículo, otra cantidad). */
  renglonesClave: string
  soloLectura?: boolean
  version?: number
}) {
  const [renglones, setRenglones] = useState<RenglonConSerie[] | null>(null)
  const [edicion, setEdicion] = useState<Record<number, Serie[]>>({})
  const [sucias, setSucias] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  const cargar = useCallback(() => {
    setError(null)
    listarSeriesRemito(comprobanteId)
      .then((lista) => {
        setRenglones(lista)
        setEdicion(Object.fromEntries(lista.map((r) => [r.renglonId, filasDe(r)])))
        setSucias(new Set())
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'No se pudieron leer los números de serie.')
        setRenglones([])
      })
  }, [comprobanteId])

  useEffect(() => {
    cargar()
  }, [cargar, renglonesClave, version])

  if (error) {
    return (
      <section className={styles.tarjeta}>
        <h3 className={styles.titulo}>Números de serie</h3>
        <p className={styles.problema}>{error}</p>
      </section>
    )
  }
  if (!renglones || renglones.length === 0) return null

  const cambiar = (renglonId: number, i: number, campo: keyof Serie, valor: string) => {
    setEdicion((prev) => {
      const filas = (prev[renglonId] ?? []).map((f, j) => (j === i ? { ...f, [campo]: valor } : f))
      return { ...prev, [renglonId]: filas }
    })
    setSucias((prev) => new Set(prev).add(renglonId))
  }

  const guardar = (renglonId: number) => {
    arrancar(async () => {
      try {
        await guardarSeriesRenglon(comprobanteId, renglonId, edicion[renglonId] ?? [])
        toast('Números de serie guardados')
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudieron guardar los números de serie.')
      }
    })
  }

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Números de serie</h3>
        <span className={styles.ayuda}>
          {soloLectura ? 'Solo lectura' : 'Uno por unidad. Van a Tango al registrar el remito.'}
        </span>
      </div>

      {renglones.map((r) => {
        const filas = edicion[r.renglonId] ?? []
        const sucia = sucias.has(r.renglonId)
        return (
          <div key={r.renglonId} className={styles.renglon}>
            <div className={styles.renglonEncabezado}>
              <span className={styles.mono}>{r.codArticu}</span>
              <span className={styles.descripcion}>{r.descripcion ?? ''}</span>
              <span className={`${styles.mono} ${styles.cantidad}`}>
                {formatCantidad(r.cantidad)} u.
              </span>
              <span className={r.problema || sucia ? styles.estadoMal : styles.estadoBien}>
                {sucia
                  ? 'Sin guardar'
                  : r.problema
                    ? 'Incompleto'
                    : r.origen === 'leidas'
                      ? 'Leídas del PDF'
                      : 'Completo'}
              </span>
            </div>

            <div className={`${styles.fila} ${styles.header}`}>
              <span>#</span>
              <span>N° de serie</span>
              <span>Descripción 1</span>
              <span>Descripción 2</span>
              <span title="Va al comentario de la serie en Tango">DNRPA</span>
            </div>
            {filas.map((f, i) => (
              <div key={i} className={styles.fila}>
                <span className={`${styles.mono} ${styles.tenue}`}>{i + 1}</span>
                <input
                  className={`${styles.input} ${styles.mono}`}
                  value={f.nSerie}
                  maxLength={LARGO_SERIE.nSerie}
                  disabled={soloLectura || pendiente}
                  onChange={(e) => cambiar(r.renglonId, i, 'nSerie', e.target.value.toUpperCase())}
                />
                <input
                  className={styles.input}
                  value={f.desc1}
                  maxLength={LARGO_SERIE.desc1}
                  disabled={soloLectura || pendiente}
                  onChange={(e) => cambiar(r.renglonId, i, 'desc1', e.target.value)}
                />
                <input
                  className={styles.input}
                  value={f.desc2}
                  maxLength={LARGO_SERIE.desc2}
                  disabled={soloLectura || pendiente}
                  onChange={(e) => cambiar(r.renglonId, i, 'desc2', e.target.value)}
                />
                <input
                  className={styles.input}
                  value={f.comentario}
                  maxLength={LARGO_SERIE.comentario}
                  disabled={soloLectura || pendiente}
                  onChange={(e) => cambiar(r.renglonId, i, 'comentario', e.target.value)}
                />
              </div>
            ))}

            {r.origen === 'leidas' && !sucia && (
              <p className={styles.aviso}>
                Leídas del comprobante. Revisalas contra el PDF, cargá el DNRPA y guardá.
              </p>
            )}
            <div className={styles.pie}>
              <span className={styles.problema}>{!sucia && r.problema ? r.problema : ''}</span>
              {!soloLectura && (
                <button
                  type="button"
                  className={styles.primario}
                  disabled={pendiente || !sucia}
                  onClick={() => guardar(r.renglonId)}
                >
                  Guardar series
                </button>
              )}
            </div>
          </div>
        )
      })}
    </section>
  )
}
