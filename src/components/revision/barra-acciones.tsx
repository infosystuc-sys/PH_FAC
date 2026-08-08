'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { confirmarComprobante, registrarComprobante } from '@/server/app/acciones'
import type { Estado } from '@/lib/estados'
import { BadgeEstado } from '@/components/badge-estado'
import { useToast } from '@/components/toast/toast-provider'
import { ModalObservacion } from './modal-observacion'
import { useAtajos } from './atajos'
import styles from './barra-acciones.module.css'

/**
 * Botón primario contextual según el estado. `leido`/`observacion` dejan
 * confirmar; `confirmado` y `registrado` muestran la acción que sigue pero
 * deshabilitada, con el título de la fase que la trae. `pendiente`/`onClick`
 * vienen de `BarraAcciones`: el atajo Ctrl+Enter y el click del botón
 * comparten la misma transición, no dos independientes.
 */
function BotonPrimario({
  estado,
  bloqueante,
  pendiente,
  sinConexion,
  bloqueanteRegistro,
  onClick,
}: {
  estado: Estado
  bloqueante: boolean
  pendiente: boolean
  sinConexion: boolean
  bloqueanteRegistro: boolean
  onClick: () => void
}) {
  if (estado === 'leido' || estado === 'observacion') {
    return (
      <button
        type="button"
        className={styles.confirmar}
        disabled={pendiente || bloqueante}
        title={bloqueante ? 'Resolvé las validaciones en error antes de confirmar' : undefined}
        onClick={onClick}
      >
        {pendiente ? 'Confirmando…' : 'Confirmar datos'}
      </button>
    )
  }

  if (estado === 'confirmado') {
    return (
      <button
        type="button"
        className={styles.registrar}
        disabled={pendiente || sinConexion || bloqueanteRegistro}
        title={
          sinConexion
            ? 'Sin conexión a Tango'
            : bloqueanteRegistro
              ? 'Resolvé los ítems del panel "Listo para registrar" antes de continuar'
              : undefined
        }
        onClick={onClick}
      >
        {pendiente ? 'Registrando…' : 'Registrar en Tango'}
      </button>
    )
  }

  if (estado === 'registrado') {
    return (
      <button type="button" className={styles.verAsiento} disabled title="Sin funcionalidad todavía">
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
  sinConexion,
  bloqueanteRegistro,
  anteriorHref,
  siguienteHref,
}: {
  id: number
  estado: Estado
  proveedor: string
  comprobante: string
  bloqueante: boolean
  sinConexion: boolean
  bloqueanteRegistro: boolean
  anteriorHref: string | null
  siguienteHref: string | null
}) {
  const [modalAbierto, setModalAbierto] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()
  const puedeObservar = estado === 'leido' || estado === 'observacion'
  const puedeConfirmar = puedeObservar && !bloqueante
  const puedeRegistrar = estado === 'confirmado' && !sinConexion && !bloqueanteRegistro

  function confirmar() {
    if (!puedeConfirmar || pendiente) return
    arrancar(async () => {
      try {
        await confirmarComprobante(id)
        toast('Comprobante confirmado.')
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo confirmar el comprobante.')
      }
    })
  }

  function registrar() {
    if (!puedeRegistrar || pendiente) return
    arrancar(async () => {
      try {
        await registrarComprobante(id)
        toast('Comprobante registrado en Tango.')
        router.refresh()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo registrar el comprobante.')
      }
    })
  }

  function accionPrimaria() {
    if (estado === 'confirmado') registrar()
    else confirmar()
  }

  useAtajos({
    onConfirmar: confirmar,
    onObservar: () => {
      if (puedeObservar) setModalAbierto(true)
    },
    anteriorHref,
    siguienteHref,
  })

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
        <BotonPrimario
          estado={estado}
          bloqueante={bloqueante}
          pendiente={pendiente}
          sinConexion={sinConexion}
          bloqueanteRegistro={bloqueanteRegistro}
          onClick={accionPrimaria}
        />
      </div>

      <ModalObservacion id={id} abierto={modalAbierto} onCerrar={() => setModalAbierto(false)} />
    </div>
  )
}
