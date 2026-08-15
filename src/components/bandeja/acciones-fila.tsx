'use client'

import { useState } from 'react'
import { ModalEliminar } from '@/components/modal-eliminar'
import styles from './acciones-fila.module.css'

/**
 * La acción de eliminar de una fila de la bandeja. Va en su propio
 * componente cliente porque `Tabla` es de servidor, y encima de la capa
 * que hace clickeable toda la fila (ver `.enlace` en tabla.module.css):
 * sin eso, el click abriría el comprobante en vez de abrir el modal.
 *
 * `className` viene de tabla.module.css: es la celda de la grilla, y ahí
 * vive la regla que revela el botón al pasar por encima de la fila (con 20
 * a 100 comprobantes por día, una papelera fija en cada renglón es un
 * blanco permanente al lado de lo que el operador clickea para abrir). No
 * puede estar acá porque `.fila` es una clase hasheada de otro módulo.
 */
export function AccionesFila({
  id,
  comprobante,
  proveedor,
  estado,
  className,
}: {
  id: number
  comprobante: string
  proveedor: string
  estado: string
  className: string
}) {
  const [abierto, setAbierto] = useState(false)

  return (
    <span className={className}>
      <button
        type="button"
        className={styles.eliminar}
        title="Eliminar comprobante"
        aria-label={`Eliminar ${comprobante}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setAbierto(true)
        }}
      >
        {/* Papelera dibujada a mano: no hay libreria de iconos en el
            proyecto y no se agrega una por un solo glifo. */}
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2.5 4h11M6.5 4V2.8c0-.3.2-.5.5-.5h2c.3 0 .5.2.5.5V4M4 4l.6 8.7c0 .4.4.8.8.8h5.2c.4 0 .8-.4.8-.8L12 4M6.6 6.6v5M9.4 6.6v5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      <ModalEliminar
        id={id}
        abierto={abierto}
        comprobante={comprobante}
        proveedor={proveedor}
        estado={estado}
        onCerrar={() => setAbierto(false)}
        // La bandeja se queda donde está: `router.refresh` del modal ya
        // saca la fila de la lista.
        alTerminar={() => {}}
      />
    </span>
  )
}
