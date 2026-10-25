import type { ResultadoListoParaRegistrar } from '@/server/app/validaciones'
import { SelectorConcepto } from './selector-concepto'
import { AplicarNetoIva } from './aplicar-neto-iva'
import styles from './listo-para-registrar.module.css'
import { Icono } from '@/components/icono'

// Los iconos de estado del sistema visual: ok, warn y error (seccion 6).
const GLIFO = { ok: 'ok', advertencia: 'warn', error: 'error' } as const

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
        <span className={`${styles.punto} ${styles[estado]}`}>
          <Icono nombre={GLIFO[estado]} size={15} />
        </span>
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
  ocultarOk = false,
}: {
  comprobanteId: number
  resultado: ResultadoListoParaRegistrar
  /** Para saber si el "sin concepto" es de una factura de conceptos: solo
   *  ahí el operador puede elegir uno, el fijo de tarjeta se carga en
   *  Tango, no por proveedor. */
  tipoFactura: string | null
  /** El proveedor al que se le asociaría el concepto elegido. */
  codProvee: string | null
  /**
   * Esconde los controles que dieron OK (2026-10-08, pedido del usuario).
   * Son dieciséis: en un comprobante sano la tarjeta es una pared de tildes
   * verdes, y lo que hay que leer es lo que falta.
   */
  ocultarOk?: boolean
}) {
  // Un remito no tiene importes, impuestos, condición de compra ni concepto:
  // de la lista quedan solo los controles que le aplican, en vez de una
  // decena de "No aplica" que el operador tendría que saltear.
  const items = tipoFactura === 'remito'
    ? [
        resultado.leyenda,
        resultado.formatoComp,
        resultado.fecha,
        resultado.tipoFactura,
        resultado.ordenCompra,
        resultado.cantidadesOc,
        resultado.renglonesNeto,
      ]
    : [
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
    // Qué se va a imprimir en la leyenda del comprobante, y si entra entera.
    resultado.leyenda,
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
    // Lo que la factura cobra por renglon contra su neto gravado -- resuelve
    // el descuento global del pie. Bloquea: es lo que se graba en CPA46.
    resultado.renglonesNeto,
    // Y esos precios contra los de la orden. Solo advierte: la factura manda.
    resultado.preciosOc,
      ]

  const visibles = ocultarOk ? items.filter((r) => r.estado !== 'ok') : items
  const enOrden = items.length - visibles.length

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Listo para registrar</h3>
      <div className={styles.lista}>
        {visibles.map((r, i) => (
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
        {/* Lo escondido se CUENTA: sacarlo sin dejar rastro haria creer que
            esos controles no se corrieron. */}
        {enOrden > 0 && (
          <p className={styles.enOrden}>
            {enOrden === 1 ? '1 control en orden' : `${enOrden} controles en orden`}
          </p>
        )}
        {visibles.length === 0 && (
          <p className={styles.todoEnOrden}>Todo en orden: el comprobante se puede registrar.</p>
        )}
      </div>
    </section>
  )
}
