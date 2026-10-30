'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { reprocesarComprobante, revalidarContraTango } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import styles from './aviso-ia.module.css'
import { Icono } from '@/components/icono'

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
  const [revalidando, arrancarRevalidar] = useTransition()
  const router = useRouter()
  const toast = useToast()

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

  // Sin IA: vuelve a mirar Tango con lo que ya está en pantalla, incluidas
  // las correcciones del operador (ver revalidarContraTangoEn). Es lo que se
  // usa después de arreglar en Tango lo que la revisión marcó.
  function revalidar() {
    arrancarRevalidar(async () => {
      try {
        const { cambios } = await revalidarContraTango(id)
        toast(
          cambios.length > 0
            ? `Revalidado contra Tango: ${cambios.join('; ')}.`
            : 'Revalidado contra Tango: sin cambios.',
        )
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo revalidar contra Tango.')
      }
    })
  }

  return (
    <div className={styles.aviso}>
      <div className={styles.icono}>
        <Icono nombre="sparkles" size={15} />
      </div>
      <div className={styles.textos}>
        <div className={styles.titulo}>Lectura automática completada</div>
        <div className={styles.detalle}>{detalle}</div>
      </div>
      <button
        type="button"
        className={styles.reprocesar}
        onClick={revalidar}
        disabled={pendiente || revalidando}
        title="Vuelve a correr las validaciones contra Tango sin leer de nuevo el PDF. Conserva tus correcciones."
      >
        {revalidando ? 'Revalidando…' : 'Revalidar contra Tango'}
      </button>
      <button
        type="button"
        className={styles.reprocesar}
        onClick={reprocesar}
        disabled={pendiente || revalidando}
        title="Vuelve a leer el PDF con IA. Descarta las correcciones hechas a mano."
      >
        {pendiente ? 'Reprocesando…' : 'Reprocesar'}
      </button>
    </div>
  )
}
