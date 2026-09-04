'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { guardarCampo } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import { formatMoneda } from '@/lib/formato'
import styles from './aplicar-neto-iva.module.css'

/**
 * Ofrece, de un clic, el neto que implican las líneas de IVA cuando el
 * declarado no cierra con ellas.
 *
 * Por qué existe: en una liquidación de tarjeta el neto gravado no viene
 * impreso, es la suma de varios cargos que la IA arma de memoria y a veces
 * arma mal (ver validarNetoContraIva). El IVA, en cambio, viene impreso y
 * rotulado, así que la base que se deduce de él es más confiable que la que
 * sumó el modelo.
 *
 * Se ofrece, no se aplica solo: la diferencia también puede venir de una
 * línea de IVA mal leída -- pasó con una percepción del 3% tomada como
 * alícuota del 21% -- y en ese caso lo que hay que corregir es el IVA, no
 * el neto. Quién tiene razón lo decide el operador mirando el PDF.
 */
export function AplicarNetoIva({
  comprobanteId,
  neto,
}: {
  comprobanteId: number
  neto: number
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  return (
    <button
      type="button"
      className={styles.boton}
      disabled={pendiente}
      onClick={() =>
        arrancar(async () => {
          // Con coma decimal: es como escribe el operador y como lo guarda
          // el resto del formulario (parsearImporte acepta las dos).
          await guardarCampo(comprobanteId, 'neto', neto.toFixed(2).replace('.', ','))
          toast(`Neto actualizado a ${formatMoneda(neto)}`)
          router.refresh()
        })
      }
    >
      {pendiente ? 'Aplicando…' : `Usar ${formatMoneda(neto)} como neto`}
    </button>
  )
}
