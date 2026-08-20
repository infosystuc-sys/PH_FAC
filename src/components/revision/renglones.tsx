import type { RenglonGuardado } from '@/server/app/detalle'
import { formatMoneda, formatCantidad } from '@/lib/formato'
import styles from './renglones.module.css'

/**
 * PHF_RENGLON guarda cantidad, precio e importe como DECIMAL: vuelven acá
 * como `"80745.57"`, no como el `"80.745,57"` que muestra el PDF. Se
 * convierten a número con `Number()` -- no con `parsearImporte`, que está
 * pensado para texto ambiguo leído por la IA (mezcla "," y "." en el mismo
 * PDF) y rompería con una cantidad de más de dos decimales como "12.3456"
 * (la interpretaría como separador de miles) -- y se muestran con
 * `formatMoneda`/`formatCantidad` (mismo separador es-AR) para que los
 * dígitos alineen en columna, como pide la regla tipográfica central del
 * diseño. La cantidad usa `formatCantidad`, sin el signo `$`: no es un
 * importe.
 */
function num(v: string | null): number | null {
  return v === null ? null : Number(v)
}

/**
 * Compara lo que factura el proveedor contra lo que entregó el remito.
 *
 * Es la misma cuenta que hace `cotejarRenglones` del lado del servidor para
 * decidir si el comprobante va a observación -- acá se repite solo para
 * pintar la marca de cada fila. Se compara con la misma tolerancia de
 * cuatro decimales, la precisión de la columna: las cantidades vienen de
 * parsear texto de un PDF y comparar con `===` marcaría en rojo una
 * diferencia de redondeo que no existe.
 */
function cotejo(
  facturada: number | null,
  remito: number | null,
): 'coincide' | 'difiere' | 'sin-remito' {
  if (remito === null) return 'sin-remito'
  if (facturada === null) return 'difiere'
  return Math.abs(facturada - remito) < 0.00005 ? 'coincide' : 'difiere'
}

export function Renglones({ renglones }: { renglones: RenglonGuardado[] }) {
  // El 77% de los comprobantes vienen solo con cabecera: una tarjeta vacía
  // sería ruido permanente en la pantalla donde el operador pasa el 90%
  // del tiempo.
  if (renglones.length === 0) return null

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Renglones detectados</h3>

      <div className={styles.header}>
        <span>Código</span>
        <span>Descripción</span>
        <span className={styles.derecha}>Remito</span>
        <span className={styles.derecha}>Cant.</span>
        <span className={styles.derecha}>P. unitario</span>
        <span className={styles.derecha}>Importe</span>
      </div>

      {renglones.map((r) => {
        const facturada = num(r.cantidad)
        const entregada = num(r.cantidadRemito)
        const estado = cotejo(facturada, entregada)

        return (
          <div key={r.orden} className={styles.fila}>
            <span className={styles.mono}>{r.codigo ?? '—'}</span>
            <span className={styles.descripcionCol}>
              <span className={styles.descripcion}>{r.descripcion ?? '—'}</span>
              {r.remitoNumero ? (
                <span className={styles.remito}>
                  Remito {r.remitoNumero}
                  {r.remitoNRenglS !== null && ` · renglón ${r.remitoNRenglS}`}
                </span>
              ) : (
                // Lo que la factura cobra y ningun remito entregó. El cotejo
                // del servidor ya lo mandó a observación; acá se nombra para
                // que el operador sepa cuál de las filas es.
                <span className={styles.sinRemito}>No figura en el remito</span>
              )}
            </span>

            <span className={`${styles.monoDerecha} ${styles[estado]}`}>
              {entregada === null ? '—' : formatCantidad(entregada)}
            </span>
            <span className={`${styles.monoDerecha} ${styles[estado]}`}>
              {formatCantidad(facturada)}
              {estado !== 'sin-remito' && (
                <span
                  className={styles.marca}
                  title={
                    estado === 'coincide'
                      ? 'Coincide con el remito'
                      : 'No coincide con lo que entregó el remito'
                  }
                >
                  {estado === 'coincide' ? '✓' : '✕'}
                </span>
              )}
            </span>

            <span className={styles.monoDerecha}>{formatMoneda(num(r.precioUnitario))}</span>
            <span className={styles.importe}>{formatMoneda(num(r.importe))}</span>
          </div>
        )
      })}
    </section>
  )
}
