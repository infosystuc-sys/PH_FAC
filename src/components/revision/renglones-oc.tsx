import type { RenglonGuardado, RenglonPdfGuardado } from '@/server/app/detalle'
import { formatMoneda, formatCantidad, parsearImporteONulo } from '@/lib/formato'
import {
  resolverDescuentoDeDetalle,
  netosPorOrden,
  describirDescuento,
} from '@/lib/descuentoGlobal'
import styles from './renglones-oc.module.css'

/**
 * Los renglones de una factura de artículos imputada a una orden de compra,
 * con lo que cobra la factura y lo que decía la orden, lado a lado.
 *
 * Pedido del usuario, 2026-09-15: "agregá los importes de la OC y de la
 * factura para que sean visualizados". Hasta ese día la tarjeta mostraba el
 * precio y el importe de la OC como si fueran los de la factura, y en una
 * factura con descuento global al pie el subtotal no cerraba contra el neto
 * sin que se viera por qué.
 *
 * Lo que manda es la factura: el precio neto de cada renglón se deriva del
 * subtotal impreso (`resolverDescuentoDeDetalle`, la misma función que usa
 * el registro para grabar CPA46), y el de la OC se muestra al lado como
 * referencia. Una diferencia de precio se marca pero no bloquea; lo que
 * bloquea es que los renglones no cierren contra el neto gravado.
 *
 * Va en Mono todo lo que se coteja contra el papel: cantidades, precios e
 * importes. La descripción y los códigos vienen de la OC, que es de donde
 * salió el artículo.
 */
export function RenglonesOc({
  renglones,
  renglonesPdf,
  descuentoGeneral,
  netoFactura,
  baseSegunImpuestos,
}: {
  /** Los renglones imputados (PHF_RENGLON con OC). */
  renglones: RenglonGuardado[]
  /** Lo que leyó la IA del PDF, con precio y subtotal impresos. */
  renglonesPdf: RenglonPdfGuardado[]
  /** El descuento global del pie, tal como está en la revisión. */
  descuentoGeneral: string | null
  /** El neto gravado de la cabecera, tal como está en la revisión. */
  netoFactura: string | null
  /** La base que implica el IVA impreso: la evidencia que decide el caso. */
  baseSegunImpuestos: number | null
}) {
  const conOc = renglones.filter((r) => r.ocNOrdenCo !== null)
  if (conOc.length === 0) return null

  const resultado = resolverDescuentoDeDetalle(
    renglonesPdf,
    descuentoGeneral,
    netoFactura,
    baseSegunImpuestos,
  )
  const netos = netosPorOrden(resultado)

  const filas = conOc.map((r) => {
    const cantidad = parsearImporteONulo(r.cantidad) ?? 0
    const precioOc = parsearImporteONulo(r.precioUnitario)
    const importeOc = precioOc === null ? null : Math.round(cantidad * precioOc * 100) / 100
    const neto = r.pdfOrden === null ? null : (netos.get(r.pdfOrden) ?? null)
    const difierePrecio =
      neto !== null && precioOc !== null && Math.abs(neto.precioNeto - precioOc) > 0.005
    return { r, cantidad, precioOc, importeOc, neto, difierePrecio }
  })

  const totalFactura = filas.reduce((acc, f) => acc + (f.neto?.importeNeto ?? 0), 0)
  const totalOc = filas.reduce((acc, f) => acc + (f.importeOc ?? 0), 0)
  const hayDiferencias = filas.some((f) => f.difierePrecio)

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Renglones: factura y orden de compra</h3>
      </div>

      <div className={styles.grupos}>
        <span />
        <span />
        <span className={styles.grupo}>Factura</span>
        <span className={styles.grupo}>Orden de compra</span>
      </div>
      <div className={styles.header}>
        <span>Artículo</span>
        <span className={styles.derecha}>Cant.</span>
        <span className={styles.derecha} title="El precio unitario tal como está impreso">
          P. unit.
        </span>
        <span className={styles.derecha} title="Lo que cobra de verdad por unidad: subtotal ÷ cantidad">
          P. neto
        </span>
        <span className={styles.derecha}>Importe</span>
        <span className={styles.derecha}>Precio</span>
        <span className={styles.derecha}>Importe</span>
      </div>

      {filas.map(({ r, cantidad, precioOc, importeOc, neto, difierePrecio }) => (
        <div key={r.orden} className={styles.fila}>
          <span className={styles.descripcionCol}>
            <span className={styles.descripcion}>{r.descripcion ?? '—'}</span>
            <span className={styles.codigos}>
              {r.codigoFinal ?? r.codigo ?? '—'}
              {r.codigoFinal !== null && (
                <span className={styles.corregido} title="Artículo corregido a mano">
                  ·
                </span>
              )}
              {' · OC '}
              {r.ocNOrdenCo?.trim()}
              {r.ocNRenglOc !== null && ` · renglón ${r.ocNRenglOc}`}
            </span>
            {neto === null && (
              <span className={styles.aviso}>
                Sin precio ni subtotal leídos para este renglón: reprocesá el comprobante.
              </span>
            )}
          </span>

          <span className={styles.mono}>{formatCantidad(cantidad)}</span>

          <span className={`${styles.mono} ${styles.tenue}`}>
            {neto === null ? '—' : formatMoneda(neto.precioImpreso)}
            {neto !== null && neto.descuentoPorc > 0.005 && (
              <span className={styles.descuento} title="Descuento efectivo sobre el precio impreso">
                {' '}
                −{formatCantidad(Math.round(neto.descuentoPorc * 100) / 100)}%
              </span>
            )}
          </span>
          <span className={`${styles.mono} ${styles.fuerte}`}>
            {neto === null ? '—' : formatMoneda(neto.precioNeto)}
          </span>
          <span className={`${styles.mono} ${styles.fuerte}`}>
            {neto === null ? '—' : formatMoneda(neto.importeNeto)}
          </span>

          <span
            className={`${styles.mono} ${difierePrecio ? styles.difiere : styles.tenue}`}
            title={
              difierePrecio
                ? 'El precio de la orden no es el que cobra la factura. Se registra el de la factura.'
                : undefined
            }
          >
            {precioOc === null ? '—' : formatMoneda(precioOc)}
            {difierePrecio && <span className={styles.marca}>≠</span>}
          </span>
          <span className={`${styles.mono} ${difierePrecio ? styles.difiere : styles.tenue}`}>
            {importeOc === null ? '—' : formatMoneda(importeOc)}
          </span>
        </div>
      ))}

      <div className={styles.filaTotal}>
        <span className={styles.totalEtiqueta}>Total renglones</span>
        <span />
        <span />
        <span />
        <span className={`${styles.mono} ${styles.fuerte} ${resultado.ok ? styles.coincide : styles.error}`}>
          {formatMoneda(totalFactura)}
          <span
            className={styles.marca}
            title={
              resultado.ok
                ? 'Cierra contra la base gravada de la factura'
                : 'No cierra contra la base gravada de la factura'
            }
          >
            {resultado.ok ? '✓' : '✕'}
          </span>
        </span>
        <span />
        <span className={`${styles.mono} ${hayDiferencias ? styles.difiere : styles.tenue}`}>
          {formatMoneda(totalOc)}
        </span>
      </div>

      <p className={`${styles.explicacion} ${resultado.ok ? '' : styles.explicacionError}`}>
        {describirDescuento(resultado)}
        {hayDiferencias &&
          ' Hay precios distintos a los de la orden: se registran los de la factura.'}
      </p>
    </section>
  )
}
