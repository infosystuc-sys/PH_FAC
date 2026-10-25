'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reprocesarComprobante } from '@/server/app/acciones'
import styles from './panel-error.module.css'
import { Icono } from '@/components/icono'

export function PanelError({
  id,
  mensaje,
  hayCorrecciones,
}: {
  id: number
  mensaje: string | null
  hayCorrecciones: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  function reprocesar() {
    if (hayCorrecciones && !confirm('Reprocesar descarta las correcciones que hiciste a mano. ¿Seguir?')) {
      return
    }
    arrancar(async () => {
      await reprocesarComprobante(id)
      router.refresh()
    })
  }

  return (
    <div className={styles.envoltura}>
      <div className={styles.caja}>
        <div className={styles.icono}>
          <Icono nombre="error" size={18} />
        </div>
        <div className={styles.titulo}>No se pudo leer el comprobante</div>
        <p className={styles.detalle}>{mensaje ?? 'La extracción falló por un motivo desconocido.'}</p>
        <button type="button" className={styles.reprocesar} onClick={reprocesar} disabled={pendiente}>
          {pendiente ? 'Reprocesando…' : 'Reprocesar'}
        </button>
      </div>
    </div>
  )
}
