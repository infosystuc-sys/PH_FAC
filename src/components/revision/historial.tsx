'use client'

import { useState } from 'react'
import type { EntradaAuditoria } from '@/server/app/detalle'
import styles from './historial.module.css'
import { Icono } from '@/components/icono'

/**
 * "dd/mm hh:mm" alcanza para distinguir entradas del mismo día sin
 * desperdiciar el ancho fijo de 104px que pide el README §2 — un
 * timestamp completo con año y segundos no entraría en mono a 11.5px.
 */
function formatTimestamp(fecha: Date): string {
  const dd = String(fecha.getDate()).padStart(2, '0')
  const mm = String(fecha.getMonth() + 1).padStart(2, '0')
  const hh = String(fecha.getHours()).padStart(2, '0')
  const mi = String(fecha.getMinutes()).padStart(2, '0')
  return `${dd}/${mm} ${hh}:${mi}`
}

/**
 * Cerrado hasta que se pide (2026-10-14, pedido del usuario): es para
 * averiguar qué pasó con un comprobante, no algo que el operador mire en
 * cada uno, y abierto ocupaba el final de la pantalla con decenas de filas.
 */
export function Historial({ entradas }: { entradas: EntradaAuditoria[] }) {
  const [abierto, setAbierto] = useState(false)

  return (
    <section className={styles.tarjeta}>
      <button
        type="button"
        className={`${styles.titulo} ${abierto ? '' : styles.tituloCerrado}`}
        onClick={() => setAbierto((v) => !v)}
        aria-expanded={abierto}
      >
        <Icono nombre={abierto ? 'chevronDown' : 'chevronRight'} size={12} />
        Historial
        <span className={styles.cantidad}>{entradas.length}</span>
      </button>
      {abierto && entradas.map((entrada, i) => (
        <div key={i} className={styles.fila}>
          <span className={styles.timestamp}>{formatTimestamp(entrada.fecha)}</span>
          <span className={styles.texto}>{entrada.texto}</span>
          <span className={styles.usuario}>{entrada.usuario}</span>
        </div>
      ))}
    </section>
  )
}
