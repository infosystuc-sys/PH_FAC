'use client'

import { useTransition } from 'react'
import { asociarCodigosProveedorEnLote } from '@/server/app/acciones/articulos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './renglones.module.css'

/**
 * La version en lote de `VincularArticulo`: hace el mismo UPSERT en CPA15
 * para todos los renglones que ya tienen los dos códigos resueltos (el
 * nuestro y el del proveedor), en vez de que el operador clickee
 * "Vincular con Tango" uno por uno -- útil en facturas de artículos con
 * muchos renglones, donde casi todos repiten el mismo proveedor.
 */
export function VincularTodos({
  comprobanteId,
  codProvee,
  pares,
}: {
  comprobanteId: number
  codProvee: string
  pares: { codArticu: string; codSinoni: string }[]
}) {
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  function vincularTodos() {
    arrancar(async () => {
      try {
        const n = await asociarCodigosProveedorEnLote(comprobanteId, codProvee, pares)
        toast(n > 0 ? `${n} código(s) vinculados con Tango.` : 'No hay nada para vincular.')
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudieron vincular los códigos.')
      }
    })
  }

  return (
    <button
      type="button"
      className={styles.actualizarRemito}
      disabled={pendiente || pares.length === 0}
      onClick={vincularTodos}
      title="Guarda en Tango (CPA15) el código del proveedor de cada renglón que ya tiene los dos códigos resueltos"
    >
      {pendiente ? 'Vinculando…' : 'Vincular todos'}
    </button>
  )
}
