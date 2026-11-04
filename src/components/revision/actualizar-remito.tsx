'use client'

import { useTransition } from 'react'
import { actualizarCantidadesRemito } from '@/server/app/acciones/remitos'
import { useToast } from '@/components/toast/toast-provider'
import styles from './renglones.module.css'

/**
 * Botón para refrescar `CANTIDAD_REMITO` contra Tango. Existe porque esa
 * columna es una foto tomada una sola vez al leer la factura (ver el
 * comentario de `actualizarCantidadesRemitoEn` en acciones/remitos.ts): si alguien
 * corrige el remito en Tango después, esta app no se entera sola.
 *
 * Acción explícita del operador, no un efecto automático -- la lectura de
 * la factura tiene que quedar estable mientras se revisa.
 */
export function ActualizarRemito({ comprobanteId }: { comprobanteId: number }) {
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  function actualizar() {
    arrancar(async () => {
      try {
        const n = await actualizarCantidadesRemito(comprobanteId)
        toast(n > 0 ? `${n} renglón(es) actualizados contra Tango.` : 'Ya estaba al día con Tango.')
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo actualizar contra Tango.')
      }
    })
  }

  return (
    <button
      type="button"
      className={styles.actualizarRemito}
      disabled={pendiente}
      onClick={actualizar}
      title="Vuelve a leer cuánto entregó cada remito según Tango hoy"
    >
      {pendiente ? 'Actualizando…' : 'Actualizar contra Tango'}
    </button>
  )
}
