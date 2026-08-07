'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { confirmarComprobante } from '@/server/app/acciones'
import type { Estado } from '@/lib/estados'
import { BadgeEstado } from '@/components/badge-estado'
import { ModalObservacion } from './modal-observacion'
import styles from './barra-acciones.module.css'

/**
 * Botón primario contextual según el estado. `leido`/`observacion` dejan
 * confirmar; `confirmado` y `registrado` muestran la acción que sigue pero
 * deshabilitada, con el título de la fase que la trae — el operador ve la
 * pantalla completa desde el principio en vez de que los botones aparezcan
 * de a uno con cada fase.
 */
function BotonPrimario({
  id,
  estado,
  bloqueante,
}: {
  id: number
  estado: Estado
  bloqueante: boolean
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()

  if (estado === 'leido' || estado === 'observacion') {
    return (
      <button
        type="button"
        className={styles.confirmar}
        disabled={pendiente || bloqueante}
        title={bloqueante ? 'Resolvé las validaciones en error antes de confirmar' : undefined}
        onClick={() =>
          arrancar(async () => {
            await confirmarComprobante(id)
            router.refresh()
          })
        }
      >
        {pendiente ? 'Confirmando…' : 'Confirmar datos'}
      </button>
    )
  }

  if (estado === 'confirmado') {
    return (
      <button type="button" className={styles.registrar} disabled title="Llega en la Fase 4">
        Registrar en Tango
      </button>
    )
  }

  if (estado === 'registrado') {
    return (
      <button type="button" className={styles.verAsiento} disabled title="Llega en la Fase 4">
        Ver asiento en Tango
      </button>
    )
  }

  return null
}

export function BarraAcciones({
  id,
  estado,
  proveedor,
  comprobante,
  bloqueante,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
  bloqueante: boolean
}) {
  const [modalAbierto, setModalAbierto] = useState(false)
  const puedeObservar = estado === 'leido' || estado === 'observacion'

  return (
    <div className={styles.barra}>
      <Link href="/comprobantes" className={styles.volver}>
        ← Bandeja
      </Link>
      <span className={styles.proveedor}>{proveedor}</span>
      <span className={styles.comprobante}>{comprobante}</span>
      <BadgeEstado estado={estado} />

      <div className={styles.derecha}>
        <button
          type="button"
          className={styles.observacion}
          disabled={!puedeObservar}
          title={puedeObservar ? undefined : 'No disponible en este estado'}
          onClick={() => setModalAbierto(true)}
        >
          Marcar en observación
        </button>
        <BotonPrimario id={id} estado={estado} bloqueante={bloqueante} />
      </div>
      <ModalObservacion id={id} abierto={modalAbierto} onCerrar={() => setModalAbierto(false)} />
    </div>
  )
}
