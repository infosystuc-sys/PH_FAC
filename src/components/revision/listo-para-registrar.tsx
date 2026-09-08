import type { ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import { SelectorConcepto } from './selector-concepto'
import { AplicarNetoIva } from './aplicar-neto-iva'
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
    // Va pegado a las alícuotas porque es su contracara: aquéllas dicen a
    // qué código de Tango va cada línea de IVA, y ésta usa esas mismas
    // líneas para cotejar que el neto sea el que corresponde.
    resultado.netoIva,
    resultado.percepcionIibb,
    resultado.varios,
    // Después de las tres familias de impuestos porque las mira a las tres
    // juntas -- Tango no admite dos veces el mismo código.
    resultado.codigosRepetidos,
    resultado.formatoComp,
    resultado.fecha,
    resultado.tipoFactura,
    resultado.concepto,
    // El cotejo contra la orden de compra va último porque es el que el
    // operador resuelve arriba, en la tarjeta de la OC, no acá.
    resultado.ordenCompra,
    // Y pegada a él, su contracara sobre las cantidades ya corregidas: el
    // cotejo mira lo que la IA leyó del PDF y ésta lo que se va a registrar.
    resultado.cantidadesOc,
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
              ) : r === resultado.netoIva &&
                r.estado !== 'ok' &&
                resultado.netoSegunIva !== null ? (
                <AplicarNetoIva comprobanteId={comprobanteId} neto={resultado.netoSegunIva} />
              ) : undefined
            }
          />
        ))}
      </div>
    </section>
  )
}
