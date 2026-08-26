'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { eliminarComprobantesEnLote } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import styles from './modal-eliminar.module.css'

/**
 * Versión en lote de `ModalEliminar`: mismo CSS module (misma caja, mismos
 * botones), pero en vez de mostrar la identidad de un comprobante muestra
 * cuántos hay seleccionados, y las advertencias de Tango van agregadas por
 * cantidad -- en un lote pueden convivir filas `registrado` y `existente` a
 * la vez, así que no alcanza con el if/else de un solo estado.
 */
export function ModalEliminarLote({
  ids,
  registrados,
  existentes,
  abierto,
  onCerrar,
  alTerminar,
}: {
  ids: number[]
  /** Cuántos de los seleccionados ya están registrados en Tango. */
  registrados: number
  /** Cuántos de los seleccionados ya existían en Tango de antes (no los registró la app). */
  existentes: number
  abierto: boolean
  onCerrar: () => void
  /** Corre después de borrar: limpia la selección de la bandeja. */
  alTerminar: () => void
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (!abierto) return null

  function eliminar() {
    arrancar(async () => {
      try {
        const { eliminados, fallidos } = await eliminarComprobantesEnLote(ids)
        toast(
          fallidos > 0
            ? `${eliminados} comprobante(s) eliminados, ${fallidos} no se pudieron eliminar.`
            : `${eliminados} comprobante(s) eliminados.`,
        )
        onCerrar()
        router.refresh()
        alTerminar()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudieron eliminar los comprobantes.')
      }
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Eliminar {ids.length} comprobante{ids.length === 1 ? '' : 's'}</h2>
        <p className={styles.subtitulo}>
          Se borra el PDF y todo lo que la app leyó de cada uno: campos, renglones e historial. No se
          puede deshacer.
        </p>

        <div className={styles.identidad}>
          <div className={styles.comprobante}>
            {ids.length} comprobante{ids.length === 1 ? '' : 's'} seleccionado{ids.length === 1 ? '' : 's'}
          </div>
        </div>

        {registrados > 0 && (
          <div className={styles.advertencia}>
            <p className={styles.advertenciaTitulo}>
              {registrados} de estos ya se registraron en Tango.
            </p>
            <p>
              Eliminarlos acá no da de baja los asientos: siguen en Tango con su imputación y su
              cuenta corriente. Lo que desaparece acá es el registro de trabajo.
            </p>
          </div>
        )}

        {existentes > 0 && (
          <div className={styles.advertencia}>
            <p className={styles.advertenciaTitulo}>
              {existentes} de estos ya existían en Tango de antes.
            </p>
            <p>No los registró esta app. Eliminarlos acá solo borra el registro de trabajo.</p>
          </div>
        )}

        <div className={styles.acciones}>
          <button type="button" className={styles.cancelar} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button type="button" className={styles.eliminar} onClick={eliminar} disabled={pendiente}>
            {pendiente ? 'Eliminando…' : `Eliminar ${ids.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
