'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { eliminarComprobante } from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import styles from './modal-eliminar.module.css'

/**
 * Confirmación de borrado. Se usa desde los dos lados -- la barra de la
 * pantalla de revisión y la fila de la bandeja -- porque la pregunta es la
 * misma y la advertencia de Tango no puede quedar en uno solo.
 *
 * `alTerminar` corre después de borrar: la revisión vuelve a la bandeja, la
 * bandeja se queda donde está y solo refresca. Por eso lo decide quien lo
 * monta y no este componente.
 */
export function ModalEliminar({
  id,
  abierto,
  comprobante,
  proveedor,
  estado,
  tangoNComp,
  onCerrar,
  alTerminar,
}: {
  id: number
  abierto: boolean
  /** "FACTURA A 0003-00018742", para que se vea qué se está por borrar. */
  comprobante: string
  proveedor: string
  estado: string
  /** El número de asiento en Tango, si llegó a registrarse. */
  tangoNComp?: string | null
  onCerrar: () => void
  alTerminar: () => void
}) {
  const [pendiente, arrancar] = useTransition()
  const router = useRouter()
  const toast = useToast()

  if (!abierto) return null

  const registrado = estado === 'registrado'

  function eliminar() {
    arrancar(async () => {
      try {
        await eliminarComprobante(id)
        toast(
          registrado
            ? 'Comprobante eliminado de la app. El asiento sigue en Tango.'
            : 'Comprobante eliminado.',
        )
        onCerrar()
        router.refresh()
        alTerminar()
      } catch (err) {
        toast(err instanceof Error ? err.message : 'No se pudo eliminar el comprobante.')
      }
    })
  }

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Eliminar comprobante</h2>
        <p className={styles.subtitulo}>
          Se borra el PDF y todo lo que la app leyó de él: campos, renglones e historial. No se
          puede deshacer.
        </p>

        <div className={styles.identidad}>
          <div className={styles.comprobante}>{comprobante}</div>
          <div className={styles.proveedor}>{proveedor}</div>
        </div>

        {registrado && (
          <div className={styles.advertencia}>
            <p className={styles.advertenciaTitulo}>Este comprobante ya se registró en Tango.</p>
            <p>
              Eliminarlo acá <strong>no da de baja el asiento</strong>
              {tangoNComp ? (
                <>
                  {' '}
                  <span className={styles.asiento}>{tangoNComp}</span>
                </>
              ) : null}
              : sigue en Tango con su imputación y su cuenta corriente. Si hay que anularlo, se hace
              desde Tango. Lo que desaparece acá es el registro de trabajo, y con él la trazabilidad
              de qué leyó la IA y qué corrigió el operador.
            </p>
          </div>
        )}

        <div className={styles.acciones}>
          <button type="button" className={styles.cancelar} onClick={onCerrar} disabled={pendiente}>
            Cancelar
          </button>
          <button type="button" className={styles.eliminar} onClick={eliminar} disabled={pendiente}>
            {pendiente ? 'Eliminando…' : 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  )
}
