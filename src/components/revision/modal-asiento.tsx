'use client'

import { useEffect, useState } from 'react'
import { verAsiento, type AsientoPreview } from '@/server/app/acciones'
import { formatMoneda } from '@/lib/formato'
import styles from './modal-asiento.module.css'

/**
 * Vista previa de solo lectura del asiento contable. Carga al abrirse --
 * no antes, no tiene sentido calcularlo si el operador nunca hace click.
 */
export function ModalAsiento({
  id,
  abierto,
  onCerrar,
}: {
  id: number
  abierto: boolean
  onCerrar: () => void
}) {
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'error'>('cargando')
  const [asiento, setAsiento] = useState<AsientoPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!abierto) return
    let vigente = true
    setEstado('cargando')
    verAsiento(id)
      .then((r) => {
        if (!vigente) return
        setAsiento(r)
        setEstado('listo')
      })
      .catch((err) => {
        if (!vigente) return
        setError(err instanceof Error ? err.message : 'No se pudo calcular el asiento.')
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
        <h2 className={styles.titulo}>Vista previa del asiento</h2>
        <p className={styles.subtitulo}>
          Simulado a partir del modelo contable de Tango. No se registra nada.
        </p>

        {estado === 'cargando' && <p className={styles.mensaje}>Calculando…</p>}
        {estado === 'error' && <p className={styles.mensajeError}>{error}</p>}

        {estado === 'listo' && asiento && (
          <>
            {asiento.lineas.length === 0 ? (
              <p className={styles.mensaje}>
                Todavía no hay datos suficientes para armar el asiento.
              </p>
            ) : (
              <>
                <div className={styles.header}>
                  <span>Cuenta</span>
                  <span className={styles.monto}>Debe</span>
                  <span className={styles.monto}>Haber</span>
                </div>
                {asiento.lineas.map((l, i) => (
                  <div key={i} className={styles.fila}>
                    <span>
                      <span className={styles.cuenta}>
                        {l.codCuenta} · {l.descCuenta}
                      </span>
                      <br />
                      <span className={styles.leyenda}>{l.leyenda}</span>
                    </span>
                    <span className={styles.monto}>{formatMoneda(l.debe)}</span>
                    <span className={styles.monto}>{formatMoneda(l.haber)}</span>
                  </div>
                ))}
                <div className={styles.totales}>
                  <span>Totales</span>
                  <span className={styles.monto}>{formatMoneda(asiento.totalDebe)}</span>
                  <span className={styles.monto}>{formatMoneda(asiento.totalHaber)}</span>
                </div>
                {!asiento.balanceado && (
                  <p className={styles.aviso}>
                    El asiento no cierra: revisá los importes cargados.
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
