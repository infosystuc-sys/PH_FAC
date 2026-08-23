import type { ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import { SelectorConcepto } from './selector-concepto'
import styles from './listo-para-registrar.module.css'

const GLIFO = { ok: '✓', advertencia: '!', error: '✕' } as const

function Item({
  estado,
  mensaje,
  extra,
}: {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
  extra?: React.ReactNode
}) {
  return (
    <div className={styles.item}>
      <div className={styles.fila}>
        <span className={`${styles.punto} ${styles[estado]}`}>{GLIFO[estado]}</span>
        <span className={styles.mensaje}>{mensaje}</span>
      </div>
      {extra}
    </div>
  )
}

export function ListoParaRegistrar({
  comprobanteId,
  resultado,
  tipoFactura,
  codProvee,
}: {
  comprobanteId: number
  resultado: ResultadoListoParaRegistrar
  /** Para saber si el "sin concepto" es de una factura de conceptos: solo
   *  ahí el operador puede elegir uno, el fijo de tarjeta se carga en
   *  Tango, no por proveedor. */
  tipoFactura: string | null
  /** El proveedor al que se le asociaría el concepto elegido. */
  codProvee: string | null
}) {
  const items = [
    resultado.condCompra,
    resultado.alicuotas,
    resultado.percepcionIibb,
    resultado.varios,
    resultado.formatoComp,
    resultado.tipoFactura,
    resultado.concepto,
  ]

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Listo para registrar</h3>
      <div className={styles.lista}>
        {items.map((r, i) => (
          <Item
            key={i}
            estado={r.estado}
            mensaje={r.mensaje}
            extra={
              r === resultado.concepto &&
              r.estado === 'error' &&
              tipoFactura === 'conceptos' &&
              codProvee ? (
                <SelectorConcepto comprobanteId={comprobanteId} codProvee={codProvee} />
              ) : undefined
            }
          />
        ))}
      </div>
    </section>
  )
}
