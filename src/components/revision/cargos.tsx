'use client'

import { useTransition } from 'react'
import { marcarCargoGravado } from '@/server/app/acciones/articulos'
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
  netoVigente,
  soloLectura = false,
}: {
  comprobanteId: number
  cargos: CargoGuardado[]
  /** El valor del campo `neto`, que puede no ser esta suma: ver el aviso de abajo. */
  netoVigente: string | null
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

  // Un centavo de diferencia es redondeo, no un ajuste: el inverso divide
  // el IVA por la alícuota y no cae justo.
  const neto = parsearImporte(netoVigente)
  const netoDifiere = Math.abs(neto - total) > 0.05

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
        <span>Suma de los cargos</span>
        <span className={styles.importe}>{formatMoneda(total)}</span>
      </div>

      {/* El neto puede no ser esta suma: cuando lo sumado no cierra contra
          el IVA impreso, el pipeline lo reemplaza por el que ese IVA implica
          (ver ajustarNetoConIvaEn). Después de ese ajuste el cotejo de
          "Listo para registrar" siempre da bien --se forzó-- así que este
          aviso es lo único que deja ver que hubo un ajuste y contra qué. */}
      {netoDifiere && (
        <p className={styles.aviso}>
          El neto gravado del comprobante es {formatMoneda(neto)}, no esta suma: se derivó del IVA
          impreso porque los cargos no cerraban. Si la diferencia te llama la atención, revisá
          contra el PDF si falta un cargo acá o si alguna línea de IVA quedó mal leída.
        </p>
      )}
    </section>
  )
}
