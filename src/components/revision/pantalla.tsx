'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { Formulario, type ValorInicial } from './formulario'
import styles from './pantalla.module.css'

/**
 * pdf.js toca APIs de navegador (`DOMMatrix`) al evaluarse el módulo. Que
 * el Visor sea 'use client' no alcanza para evitarlo: Next igual lo
 * renderiza del lado del servidor en el primer paso, y ese require
 * explota ahí con "DOMMatrix is not defined" -- el Visor nunca había
 * estado montado dentro del árbol de una página hasta esta pantalla, así
 * que el problema estaba latente. Se importa dinámico con `ssr: false`
 * para que el módulo (y pdf.js con él) recién se cargue en el navegador.
 * No se toca visor.tsx: el problema es de dónde se monta, no de cómo
 * está escrito.
 */
const Visor = dynamic(() => import('./visor').then((m) => m.Visor), { ssr: false })

/**
 * Contenedor cliente del cuerpo de dos paneles. Sostiene el estado del
 * campo enfocado y se lo pasa al Visor para que resalte, en la capa de
 * texto del PDF, la zona que corresponde al campo que el operador está
 * mirando en el Formulario.
 */
export function Pantalla({
  comprobanteId,
  nombreArchivo,
  iniciales,
}: {
  comprobanteId: number
  nombreArchivo: string
  iniciales: Record<string, ValorInicial>
}) {
  const [enfocado, setEnfocado] = useState<string | null>(null)

  return (
    <div className={styles.cuerpo}>
      <Visor id={comprobanteId} nombre={nombreArchivo} resaltar={enfocado} />
      <Formulario comprobanteId={comprobanteId} iniciales={iniciales} onEnfocar={setEnfocado} />
    </div>
  )
}
