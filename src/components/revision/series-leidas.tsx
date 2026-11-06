'use client'

import { useState } from 'react'
import type { SeriePdfGuardada } from '@/server/app/detalle'
import styles from './series-leidas.module.css'

/**
 * Los números de serie que la IA leyó de UN renglón del comprobante, para
 * revisarlos contra el PDF en la misma tabla de renglones, antes de elegir
 * la orden de compra (2026-11-05, pedido del usuario). Solo lectura: se
 * corrigen y se les carga el DNRPA en la tarjeta "Números de serie", que
 * aparece cuando el renglón ya tiene su orden.
 *
 * Los rótulos son los de las motos (chasis, motor, color) porque es lo que
 * hoy se lee del papel; en Tango van a N_SERIE, DESC1 y DESC2.
 */
export function SeriesLeidas({ series, cantidad }: { series: SeriePdfGuardada[]; cantidad: number | null }) {
  const [abierto, setAbierto] = useState(false)
  if (series.length === 0) return null

  const noCierra = cantidad !== null && Math.abs(cantidad - series.length) > 0.00005

  return (
    <div className={styles.caja}>
      <button type="button" className={styles.toggle} onClick={() => setAbierto((x) => !x)} aria-expanded={abierto}>
        <span className={styles.flecha}>{abierto ? '▾' : '▸'}</span>
        {series.length} número(s) de serie leído(s) del comprobante
        {noCierra && (
          <span className={styles.alerta}>
            {' '}· el renglón dice {cantidad}: revisá contra el PDF
          </span>
        )}
      </button>
      {abierto && (
        <div className={styles.lista}>
          <div className={`${styles.fila} ${styles.header}`}>
            <span>#</span>
            <span title="Va a N_SERIE">Chasis</span>
            <span title="Va a DESC1">Motor</span>
            <span title="Va a DESC2">Color</span>
          </div>
          {series.map((s) => (
            <div key={s.orden} className={styles.fila}>
              <span className={styles.tenue}>{s.orden}</span>
              <span>{s.nSerie}</span>
              <span>{s.desc1 ?? '—'}</span>
              <span>{s.desc2 || '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
