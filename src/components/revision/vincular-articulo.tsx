'use client'

import { useTransition } from 'react'
import { asociarCodigoProveedor } from '@/server/app/acciones/articulos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './renglones.module.css'

/**
 * Guarda en CPA15 que el código con el que este proveedor imprime el
 * artículo en SU factura es este artículo nuestro. Es aprendizaje: la
 * próxima factura del mismo proveedor trae el mismo código impreso, y con
 * esto la segunda pasada de IA lo va a poder emparejar directo, sin
 * depender de que la descripción se parezca.
 *
 * Separado de `SelectorArticulo` a propósito: no es corregir este renglón,
 * es enseñarle a Tango algo que vale para las facturas que vengan. Antes
 * vivía escondido adentro del panel de "Cambiar artículo" y casi no se
 * usaba porque había que abrirlo primero -- ahora es un botón visible en
 * cada renglón que ya tiene los dos códigos resueltos.
 */
export function VincularArticulo({
  comprobanteId,
  codProvee,
  codArticu,
  codSinoni,
}: {
  comprobanteId: number
  codProvee: string
  /** Nuestro código de artículo, el que se graba en Tango. */
  codArticu: string
  /** El código con el que el proveedor lo imprime en su factura. */
  codSinoni: string
}) {
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  function vincular() {
    arrancar(async () => {
      try {
        await asociarCodigoProveedor(comprobanteId, codProvee, codArticu, codSinoni)
        toast(`Tango ya sabe que "${codSinoni}" es ${codArticu}.`)
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo vincular el código.')
      }
    })
  }

  return (
    <button
      type="button"
      className={styles.vincular}
      disabled={pendiente}
      onClick={vincular}
      title={`Guarda en Tango (CPA15) que "${codSinoni}" es el artículo ${codArticu}`}
    >
      {pendiente ? 'Vinculando…' : 'Vincular con Tango'}
    </button>
  )
}
