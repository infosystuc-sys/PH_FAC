'use client'

import { useTransition } from 'react'
import { marcarCargoGravado } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import { formatMoneda } from '@/lib/formato'
import { parsearImporte } from '@/lib/formato'
import type { CargoGuardado } from '@/server/app/detalle'
import styles from './cargos.module.css'

/**
 * Los cargos que componen el neto gravado de una liquidación de tarjeta,
 * con el detalle de cuáles suman.
 *
 * Existe porque en estos comprobantes el neto no viene impreso: es la suma
 * de varios cargos que cada procesadora rotula distinto. Antes ese número
 * llegaba sin explicación --lo sumaba el modelo de memoria, y a veces se
 * comía un cargo-- y el operador no tenía cómo cotejarlo contra el PDF sin
 * rehacer la cuenta a mano. Acá ve de dónde sale cada peso.
 *
 * Destildar un cargo lo saca de la suma, recalcula el neto y se lo aprende
 * al proveedor: la liquidación del mes que viene ya viene bien.
 */
export function Cargos({
  comprobanteId,
  cargos,
  soloLectura = false,
}: {
  comprobanteId: number
  cargos: CargoGuardado[]
  soloLectura?: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  // Sin cargos no hay nada que mostrar: pasa en todo lo que no sea tarjeta,
  // y en una liquidación donde el modelo no pudo desglosar nada.
  if (cargos.length === 0) return null

  const total = cargos
    .filter((c) => c.gravado)
    .reduce((a, c) => a + parsearImporte(c.importe), 0)

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Cargos que componen el neto gravado</h3>
        <span className={styles.ayuda}>
          {soloLectura ? 'Solo lectura' : 'Destildá los que no formen parte de la base'}
        </span>
      </div>

      <div className={styles.lista}>
        {cargos.map((c) => (
          <label key={c.id} className={`${styles.fila} ${c.gravado ? '' : styles.excluida}`}>
            <input
              type="checkbox"
              checked={c.gravado}
              disabled={soloLectura || pendiente}
              onChange={(e) => {
                const gravado = e.target.checked
                arrancar(async () => {
                  await marcarCargoGravado(comprobanteId, c.id, gravado)
                  toast(
                    gravado
                      ? `"${c.concepto ?? 'Cargo'}" vuelve a sumar al neto`
                      : `"${c.concepto ?? 'Cargo'}" ya no suma al neto`,
                  )
                })
              }}
            />
            <span className={styles.concepto}>{c.concepto ?? '(sin rótulo)'}</span>
            <span className={styles.importe}>{formatMoneda(parsearImporte(c.importe))}</span>
          </label>
        ))}
      </div>

      <div className={styles.total}>
        <span>Neto gravado</span>
        <span className={styles.importe}>{formatMoneda(total)}</span>
      </div>
    </section>
  )
}
