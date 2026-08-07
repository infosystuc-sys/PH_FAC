'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reprocesarComprobante } from '@/server/app/acciones'
import styles from './aviso-ia.module.css'

export function AvisoIA({
  id,
  campos,
  ms,
  modelo,
  confianza,
  hayCorrecciones,
}: {
  id: number
  campos: number
  ms: number | null
  modelo: string | null
  confianza: number | null
  hayCorrecciones: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  const detalle = [
    `Claude leyó ${campos} campos`,
    ms === null ? null : `${(ms / 1000).toFixed(1).replace('.', ',')} s`,
    confianza === null ? null : `confianza promedio ${Math.round(confianza * 100)}%`,
    modelo,
  ]
    .filter(Boolean)
    .join(' · ')

  function reprocesar() {
    // Reprocesar borra PHF_CAMPO y lo vuelve a insertar desde cero (ver
    // guardarExtraccionEn en server/app/detalle.ts): cualquier corrección
    // manual que no coincida con lo que la IA vuelva a leer se pierde.
    // Solo se pregunta si hay algo que perder -- si el operador no tocó
    // nada, la confirmación sería fricción sin sentido.
    if (hayCorrecciones && !confirm('Reprocesar descarta las correcciones que hiciste a mano. ¿Seguir?')) {
      return
    }
    arrancar(async () => {
      await reprocesarComprobante(id)
      router.refresh()
    })
  }

  return (
    <div className={styles.aviso}>
      <div className={styles.icono}>✦</div>
      <div className={styles.textos}>
        <div className={styles.titulo}>Lectura automática completada</div>
        <div className={styles.detalle}>{detalle}</div>
      </div>
      <button type="button" className={styles.reprocesar} onClick={reprocesar} disabled={pendiente}>
        {pendiente ? 'Reprocesando…' : 'Reprocesar'}
      </button>
    </div>
  )
}
