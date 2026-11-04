'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { marcarObservacion } from '@/server/app/acciones/comprobantes'
import { MOTIVOS_OBSERVACION } from '@/lib/observacion'
import { useToast } from '@/components/toast/toast-provider'
import styles from './modal-observacion.module.css'

export function ModalObservacion({
  id,
  abierto,
  onCerrar,
}: {
  id: number
  abierto: boolean
  onCerrar: () => void
}) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const [nota, setNota] = useState('')
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (!abierto) return null

  function confirmar() {
    if (!motivo) return
    arrancar(async () => {
      try {
        await marcarObservacion(id, motivo, nota)
        toast('Comprobante marcado en observación.')
        onCerrar()
        router.push('/comprobantes')
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo marcar el comprobante en observación.')
      }
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Marcar en observación</h2>
        <p className={styles.subtitulo}>
          El comprobante queda pendiente y no se registra en Tango hasta resolverlo.
        </p>

        <div className={styles.motivos}>
          {MOTIVOS_OBSERVACION.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.motivo} ${motivo === m ? styles.motivoElegido : ''}`}
              onClick={() => setMotivo(m)}
            >
              {m}
            </button>
          ))}
        </div>

        <textarea
          className={styles.nota}
          placeholder="Nota para el equipo (opcional)"
          value={nota}
          maxLength={1000}
          onChange={(e) => setNota(e.target.value)}
        />

        <div className={styles.acciones}>
          <button type="button" className={styles.cancelar} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button type="button" className={styles.confirmar} onClick={confirmar} disabled={!motivo || pendiente}>
            {pendiente ? 'Guardando…' : 'Marcar en observación'}
          </button>
        </div>
      </div>
    </div>
  )
}
