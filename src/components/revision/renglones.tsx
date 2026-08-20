import type { RenglonGuardado } from '@/server/app/detalle'
import { formatMoneda, formatCantidad, parsearImporte } from '@/lib/formato'
import { SelectorArticulo } from './selector-articulo'
import type { RemitoPendiente } from '@/server/tango/remitos'
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

export function Renglones({
  comprobanteId,
  renglones,
  remitos,
  codProvee,
  netoFactura,
  soloLectura = false,
}: {
  comprobanteId: number
  renglones: RenglonGuardado[]
  /** Los remitos con saldo del proveedor, para poder reasignar un renglón. */
  remitos: RemitoPendiente[]
  /** El proveedor del comprobante, para buscar y asociar artículos. */
  codProvee: string | null
  /**
   * El neto gravado de la cabecera, tal como lo tipeó o corrigió el
   * operador. Los renglones son importes base -- antes de IVA -- así que
   * es contra este campo que tienen que cerrar, no contra el total.
   */
  netoFactura: string | null
  /** Comprobante registrado: terminal, no se corrige nada. */
  soloLectura?: boolean
}) {
  // El 77% de los comprobantes vienen solo con cabecera: una tarjeta vacía
  // sería ruido permanente en la pantalla donde el operador pasa el 90%
  // del tiempo.
  if (renglones.length === 0) return null

  // Los renglones de remito ya tomados: el selector no vuelve a ofrecerlos,
  // asi que el mismo no se puede asignar a dos renglones de la factura.
  const yaAsignados = new Set(
    renglones
      .filter((r) => r.remitoNcompInS && r.remitoNRenglS)
      .map((r) => `${r.remitoNcompInS}-${r.remitoNRenglS}`),
  )

  // Solo los remitos que ESTE comprobante referencia. `buscarRemitosPendientes`
  // trae todos los del proveedor -- con TOPPER son 132 renglones -- y ofrecer
  // los de otros remitos no ayuda: si la factura apunta al remito equivocado,
  // eso se arregla corrigiendo el numero en la cabecera, no reapuntando
  // renglon por renglon.
  const internosDelComprobante = new Set(
    renglones.map((r) => r.remitoNcompInS).filter((x): x is string => x !== null),
  )
  const remitosPropios = remitos.filter((x) => internosDelComprobante.has(x.numeroInterno))

  // Los renglones del remito que ningun renglon de la factura cobra. No
  // tienen fila propia porque la tarjeta muestra PHF_RENGLON, que son los
  // renglones de la FACTURA: un articulo entregado que nadie facturo no
  // genera ninguno. Se pintan igual, en gris, para que el operador compare
  // en una sola grilla en vez de leerlos en la nota de observacion -- que
  // ademas se corta a 1.000 caracteres y con muchas diferencias no entran.
  //
  // Es el caso mas caro de los dos: mercaderia que entro al deposito y el
  // proveedor todavia no facturo, o un renglon que el modelo perdio al leer.
  const noFacturados = remitosPropios.flatMap((remito) =>
    remito.renglones
      .filter((rr) => !yaAsignados.has(`${remito.numeroInterno}-${rr.nRenglon}`))
      .map((rr) => ({ remito, rr })),
  )

  // Suma solo lo que la factura cobra -- las filas fantasma no tienen
  // importe real, muestran "—". Tiene que cerrar contra el neto gravado de
  // la cabecera: los renglones son importes base, antes de IVA.
  const subtotal = renglones.reduce((acc, r) => acc + (num(r.importe) ?? 0), 0)
  const neto = parsearImporte(netoFactura)
  // Tolerancia de redondeo: PRECIO_NET se guarda con 4 decimales y el
  // importe de cada renglon se redondea a 2 al insertar, asi que un
  // comprobante con muchos renglones acumula un poco de diferencia sin que
  // haya ningun error real (visto en un caso real: 6 centavos en 13
  // renglones).
  const tolerancia = Math.max(0.05, renglones.length * 0.01)
  const cierraContraNeto = neto > 0 && Math.abs(subtotal - neto) < tolerancia

  return (
    <section className={styles.tarjeta}>
      <h3 className={styles.titulo}>Renglones detectados</h3>

      <div className={styles.header}>
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
        // La correccion manual gana sobre lo que resolvio el emparejamiento
        // automatico, que es para lo que existe.
        const codigo = r.codigoFinal ?? r.codigo

        return (
          <div key={r.orden} className={styles.fila}>
            <span className={styles.descripcionCol}>
              <span className={styles.descripcion}>{r.descripcion ?? '—'}</span>
              <span className={styles.codigos}>
                Tango {codigo ?? '—'}
                {r.codigoFinal !== null && (
                  <span className={styles.corregido} title="Artículo corregido a mano">
                    ·
                  </span>
                )}
                {' · Factura '}
                {r.codProveedor ?? '—'}
              </span>
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
              {!soloLectura && (
                <SelectorArticulo
                  comprobanteId={comprobanteId}
                  renglonId={r.id}
                  corregido={r.codigoFinal !== null}
                  remitos={remitosPropios}
                  yaAsignados={yaAsignados}
                  remitoActual={
                    r.remitoNcompInS && r.remitoNRenglS
                      ? `${r.remitoNcompInS}-${r.remitoNRenglS}`
                      : null
                  }
                  codProvee={codProvee}
                  codProveedorLeido={r.codProveedor}
                  codArticuloActual={codigo}
                />
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

            <span className={styles.monoDerecha}>
              {formatMoneda(num(r.precioUnitario))}
              {/* El precio impreso es el de lista y el importe ya viene
                  descontado: sin mostrar la bonificacion, cantidad x precio
                  no da el importe y el operador cree que hay un error. */}
              {num(r.porcBonif) ? (
                <span className={styles.bonif}>
                  {' '}
                  −{formatCantidad(num(r.porcBonif))}%
                </span>
              ) : null}
            </span>
            <span className={styles.importe}>{formatMoneda(num(r.importe))}</span>
          </div>
        )
      })}

      {noFacturados.map(({ remito, rr }) => (
        <div key={`no-${remito.numeroInterno}-${rr.nRenglon}`} className={styles.fila}>
          <span className={styles.descripcionCol}>
            <span className={`${styles.descripcion} ${styles.fantasma}`}>
              {rr.descripcion ?? 'sin descripción'}
            </span>
            <span className={`${styles.codigos} ${styles.fantasma}`}>Tango {rr.codArticulo}</span>
            <span className={styles.remito}>
              Remito {remito.numero} · renglón {rr.nRenglon}
            </span>
            <span className={styles.sinRemito}>La factura no lo cobra</span>
          </span>

          <span className={`${styles.monoDerecha} ${styles.difiere}`}>
            {formatCantidad(rr.cantidadPendiente)}
          </span>
          <span className={`${styles.monoDerecha} ${styles.difiere}`}>
            —
            <span className={styles.marca} title="El remito lo entregó y la factura no lo cobra">
              ✕
            </span>
          </span>

          <span className={`${styles.monoDerecha} ${styles.fantasma}`}>—</span>
          <span className={`${styles.importe} ${styles.fantasma}`}>—</span>
        </div>
      ))}

      <div className={styles.filaSubtotal}>
        <span className={styles.subtotalEtiqueta}>Subtotal renglones</span>
        <span
          className={`${styles.importe} ${neto > 0 ? styles[cierraContraNeto ? 'coincide' : 'difiere'] : ''}`}
        >
          {formatMoneda(subtotal)}
          {neto > 0 && (
            <span
              className={styles.marca}
              title={
                cierraContraNeto
                  ? 'Coincide con el neto gravado de la factura'
                  : `No coincide con el neto gravado (${formatMoneda(neto)})`
              }
            >
              {cierraContraNeto ? '✓' : '✕'}
            </span>
          )}
        </span>
      </div>
    </section>
  )
}
