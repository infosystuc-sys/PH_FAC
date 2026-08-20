'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { asignarRemito } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import type { RemitoPendiente } from '@/server/tango/remitos'
import type { RenglonGuardado } from '@/server/app/detalle'
import styles from './remitos-pendientes.module.css'

export function RemitosPendientes({
  comprobanteId,
  renglones,
  remitos,
}: {
  comprobanteId: number
  renglones: RenglonGuardado[]
  remitos: RemitoPendiente[]
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (remitos.length === 0 || renglones.length === 0) return null

  const asignados = new Set(
    renglones
      .filter((r) => r.remitoNcompInS && r.remitoNRenglS)
      .map((r) => `${r.remitoNcompInS}-${r.remitoNRenglS}`),
  )

  function cambiar(renglonId: number, valor: string) {
    arrancar(async () => {
      try {
        if (!valor) {
          await asignarRemito(comprobanteId, renglonId, null, null, null)
        } else {
          const [ncompInS, nRenglS, numero] = valor.split('|')
          await asignarRemito(comprobanteId, renglonId, ncompInS, Number(nRenglS), numero)
        }
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo asignar el remito.')
      }
    })
  }

  return (
    <div className={styles.panel}>
      <h3 className={styles.titulo}>Remitos pendientes</h3>
      {renglones.map((r) => {
        const valorActual =
          r.remitoNcompInS && r.remitoNRenglS
            ? `${r.remitoNcompInS}|${r.remitoNRenglS}|${r.remitoNumero ?? ''}`
            : ''
        return (
          <div key={r.id} className={styles.fila}>
            <span className={styles.descripcion}>{r.descripcion ?? `Renglón ${r.id}`}</span>
            <select
              className={styles.select}
              value={valorActual}
              disabled={pendiente}
              onChange={(e) => cambiar(r.id, e.target.value)}
            >
              <option value="">Sin remito</option>
              {remitos.map((remito) =>
                remito.renglones.map((rr) => {
                  const clave = `${remito.numeroInterno}-${rr.nRenglon}`
                  if (asignados.has(clave) && clave !== `${r.remitoNcompInS}-${r.remitoNRenglS}`) return null
                  return (
                    <option key={clave} value={`${remito.numeroInterno}|${rr.nRenglon}|${remito.numero}`}>
                      Remito {remito.numero} — {rr.descripcion ?? rr.codArticulo} (pend. {rr.cantidadPendiente})
                    </option>
                  )
                }),
              )}
            </select>
          </div>
        )
      })}
    </div>
  )
}
