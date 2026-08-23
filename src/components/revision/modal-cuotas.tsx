'use client'

import { useEffect, useState } from 'react'
import { verCuotas, type CuotasPreview } from '@/server/app/acciones'
import { formatMoneda, formatFecha } from '@/lib/formato'
import styles from './modal-cuotas.module.css'

/**
 * Vista previa de solo lectura de los vencimientos (CPA54) que se
 * grabarian en la cuenta corriente del proveedor. Mismo patron que
 * ModalAsiento: carga al abrirse, no antes.
 */
export function ModalCuotas({
  id,
  abierto,
  onCerrar,
}: {
  id: number
  abierto: boolean
  onCerrar: () => void
}) {
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando')
  const [cuotas, setCuotas] = useState<CuotasPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!abierto) return
    let vigente = true
    setEstado('cargando')
    verCuotas(id)
      .then((r) => {
        if (!vigente) return
        setCuotas(r)
        setEstado('listo')
      })
      .catch((err) => {
        if (!vigente) return
        setError(err instanceof Error ? err.message : 'No se pudieron calcular las cuotas.')
        setEstado('error')
      })
    return () => {
      vigente = false
    }
  }, [abierto, id])

  if (!abierto) return null

  return (
    <div className={styles.overlay} onClick={onCerrar}>
      <div className={styles.caja} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.titulo}>Vista previa de las cuotas</h2>
        <p className={styles.subtitulo}>
          Vencimientos que se grabarían en la cuenta corriente del proveedor (CPA54). No se registra nada.
        </p>

        {estado === 'cargando' && <p className={styles.mensaje}>Calculando…</p>}
        {estado === 'error' && <p className={styles.mensajeError}>{error}</p>}

        {estado === 'listo' && cuotas && (
          <>
            {cuotas.cuotas.length === 0 ? (
              <p className={styles.mensaje}>
                Todavía no hay datos suficientes para calcular las cuotas.
              </p>
            ) : (
              <>
                <p className={styles.condicion}>{cuotas.condicionDescripcion}</p>
                <div className={styles.header}>
                  <span>Cuota</span>
                  <span>Vencimiento</span>
                  <span className={styles.monto}>%</span>
                  <span className={styles.monto}>Importe</span>
                </div>
                {cuotas.cuotas.map((c) => (
                  <div key={c.nroCuota} className={styles.fila}>
                    <span>{c.nroCuota}</span>
                    <span className={styles.fecha}>{formatFecha(c.fechaVencimiento)}</span>
                    <span className={styles.monto}>{c.porcentaje}%</span>
                    <span className={styles.monto}>{formatMoneda(c.importe)}</span>
                  </div>
                ))}
                <div className={styles.totales}>
                  <span>Total</span>
                  <span />
                  <span />
                  <span className={styles.monto}>{formatMoneda(cuotas.totalCuotas)}</span>
                </div>
                {!cuotas.cierra && (
                  <p className={styles.aviso}>
                    Las cuotas no cierran contra el total del comprobante ({formatMoneda(cuotas.totalComprobante)}).
                  </p>
                )}
              </>
            )}
          </>
        )}

        <div className={styles.acciones}>
          <button type="button" className={styles.cerrar} onClick={onCerrar}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
