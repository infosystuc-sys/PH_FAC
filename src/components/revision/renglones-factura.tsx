'use client'

import { Fragment, useCallback, useEffect, useState, useTransition } from 'react'
import {
  listarOcParaComprobante,
  imputarOcARenglon,
  imputarOrdenCompra,
  quitarOcDeRenglon,
  type OfertaOc,
} from '@/server/app/acciones/ordenesCompra'
import type { RenglonGuardado, RenglonPdfGuardado } from '@/server/app/detalle'
import { useToast } from '@/components/toast/toast-provider'
import {
  formatMoneda,
  formatCantidad,
  formatFecha,
  parsearImporteONulo,
} from '@/lib/formato'
import {
  resolverDescuentoDeDetalle,
  netosPorOrden,
  describirDescuento,
} from '@/lib/descuentoGlobal'
import { ProblemaRenglon } from './problema-renglon'
import styles from './renglones-factura.module.css'

/** La oferta vacía con la que se sigue cuando falla la búsqueda de OC. */
const OFERTA_VACIA: OfertaOc = {
  ocs: [],
  filtrada: false,
  sinResolver: [],
  articulosDisponibles: [],
  imputadas: [],
  sinOrden: [],
  codigosFactura: {},
  cargos: [],
  todas: [],
  candidatasPorRenglon: {},
}

/**
 * Los renglones de una factura de artículos: lo que leyó la IA del papel,
 * a qué artículo de Tango corresponde cada uno, y la orden de compra a la
 * que se imputa.
 *
 * Pedido del usuario, 2026-10-14: una sola tabla, a todo el ancho, debajo
 * de las cuatro tarjetas de datos, y la OC se elige EN CADA RENGLÓN, en la
 * última columna. Hasta ese día la OC se imputaba a la factura entera
 * desde una tarjeta aparte, y la tabla de renglones recién aparecía
 * después de imputarla: el operador no veía qué renglón iba contra qué
 * orden hasta haber elegido.
 *
 * Al elegir la OC del PRIMER renglón se pregunta si va para el resto: es
 * el caso de casi todas las facturas, una sola orden para todo. Si dice que
 * sí se imputa la orden entera, que empareja cada renglón contra su
 * artículo; los que esa orden no trae quedan sin OC, a la vista, para
 * elegirles otra.
 *
 * Una fila por renglón del PDF, no por renglón de Tango: una línea
 * desglosada por talle es una sola en el papel y varios artículos en
 * Tango, que se listan dentro de la misma fila.
 */
export function RenglonesFactura({
  comprobanteId,
  codProvee,
  renglones,
  renglonesPdf,
  descuentoGeneral,
  netoFactura,
  baseSegunImpuestos,
  soloLectura = false,
  esRemito = false,
  version = 0,
}: {
  /**
   * Un remito de proveedor (2026-10-25): la misma tabla, pero contra lo
   * pendiente de RECIBIR de cada orden y sin importes -- un remito no cobra,
   * así que ni el total ni el cierre contra el neto tienen sentido.
   */
  esRemito?: boolean
  comprobanteId: number
  codProvee: string | null
  /** Lo que se va a grabar en Tango (PHF_RENGLON), con su OC. */
  renglones: RenglonGuardado[]
  /** Lo que leyó la IA del PDF, con precio y subtotal impresos. */
  renglonesPdf: RenglonPdfGuardado[]
  descuentoGeneral: string | null
  netoFactura: string | null
  /** La base que implica el IVA impreso: la evidencia que decide el caso. */
  baseSegunImpuestos: number | null
  soloLectura?: boolean
  /**
   * Cambia cada vez que el servidor anota algo en el historial del
   * comprobante. Las órdenes y los artículos reconocidos se piden a Tango
   * desde acá y no viajan con la página, así que sin esto un
   * "Revalidar contra Tango" refrescaba todo menos esta tabla: el sinónimo
   * recién cargado en Tango seguía sin aparecer (2026-10-30).
   */
  version?: number
}) {
  const [oferta, setOferta] = useState<OfertaOc | null>(null)
  const [errorCarga, setErrorCarga] = useState<string | null>(null)
  // La pregunta de "¿va para el resto?", abierta sobre una OC ya elegida.
  const [pregunta, setPregunta] = useState<{ pdfOrden: number; nOrdenCo: string } | null>(null)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  const cargar = useCallback(() => {
    if (!codProvee) {
      setOferta(null)
      return
    }
    setErrorCarga(null)
    listarOcParaComprobante(comprobanteId, codProvee)
      .then(setOferta)
      .catch((e: unknown) => {
        // No se traga: una tabla sin ordenes parece un proveedor sin ordenes.
        setErrorCarga(e instanceof Error ? e.message : 'No se pudieron buscar las órdenes de compra.')
        setOferta(OFERTA_VACIA)
      })
  }, [comprobanteId, codProvee])

  useEffect(cargar, [cargar, version])

  const resultado = resolverDescuentoDeDetalle(
    renglonesPdf,
    descuentoGeneral,
    netoFactura,
    baseSegunImpuestos,
  )
  const netos = netosPorOrden(resultado)

  const lineas = [...renglonesPdf].sort((a, b) => a.orden - b.orden)
  const cargos = new Set((oferta?.cargos ?? []).map((c) => c.orden))
  const sinOrden = new Map((oferta?.sinOrden ?? []).map((r) => [r.orden, r]))
  const fechaDe = new Map((oferta?.todas ?? []).map((oc) => [oc.nOrdenCo, oc]))
  // El "primer renglon" es el primero que va contra una orden: un cargo
  // arriba de todo no cuenta, no tiene OC que elegir.
  const contraOc = lineas.filter((l) => !cargos.has(l.orden))
  const primero = contraOc[0]?.orden ?? null

  const imputarUno = (pdfOrden: number, nOrdenCo: string) =>
    arrancar(async () => {
      try {
        await imputarOcARenglon(comprobanteId, pdfOrden, nOrdenCo, codProvee)
        toast(`Orden ${nOrdenCo.trim()} imputada al renglón ${pdfOrden}`)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo imputar la orden de compra.')
      }
    })

  const imputarATodos = (pdfOrden: number, nOrdenCo: string) =>
    arrancar(async () => {
      try {
        // Primero el renglon elegido, para que si tenia otra orden la
        // cambie; despues la orden entera, que no pisa los renglones que ya
        // tienen OTRA orden.
        await imputarOcARenglon(comprobanteId, pdfOrden, nOrdenCo, codProvee)
        const { renglones: n, sinEmparejar } = await imputarOrdenCompra(
          comprobanteId,
          nOrdenCo,
          codProvee,
        )
        const resto = sinEmparejar > 0 ? ` — ${sinEmparejar} renglón(es) no están en esta orden` : ''
        toast(`Orden ${nOrdenCo.trim()} imputada: ${n} renglón(es)${resto}`)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo imputar la orden de compra.')
      }
    })

  const quitar = (pdfOrden: number) =>
    arrancar(async () => {
      try {
        await quitarOcDeRenglon(comprobanteId, pdfOrden)
        toast(`Orden quitada del renglón ${pdfOrden}`)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo quitar la orden de compra.')
      }
    })

  const elegir = (pdfOrden: number, nOrdenCo: string) => {
    if (nOrdenCo === '') {
      quitar(pdfOrden)
      return
    }
    if (pdfOrden === primero && contraOc.length > 1) {
      setPregunta({ pdfOrden, nOrdenCo })
      return
    }
    imputarUno(pdfOrden, nOrdenCo)
  }

  let totalFactura = 0
  let totalOc = 0
  let hayDiferencias = false

  const filas = lineas.map((l) => {
    const neto = netos.get(l.orden) ?? null
    const enTango = renglones.filter((r) => r.pdfOrden === l.orden)
    const ocActual = enTango.find((r) => r.ocNOrdenCo !== null)?.ocNOrdenCo ?? null
    const esCargo = cargos.has(l.orden) || (enTango.length > 0 && enTango.every((r) => r.ocNOrdenCo === null))

    const imputados = enTango.map((r) => {
      const precioOc = r.ocNOrdenCo === null ? null : parsearImporteONulo(r.precioUnitario)
      const cantidad = parsearImporteONulo(r.cantidad) ?? 0
      const difiere =
        neto !== null && precioOc !== null && Math.abs(neto.precioNeto - precioOc) > 0.005
      if (precioOc !== null) totalOc += Math.round(cantidad * precioOc * 100) / 100
      if (difiere) hayDiferencias = true
      // Lo que la orden tenia pendiente de ese articulo al imputarla: si la
      // factura cobra mas, se marca (el panel de validaciones lo bloquea).
      const pendienteOc = r.ocNOrdenCo === null ? null : parsearImporteONulo(r.ocPendiente)
      const excede = pendienteOc !== null && cantidad > pendienteOc + 0.00005
      return { r, precioOc, difiere, pendienteOc, excede }
    })
    if (neto) totalFactura += neto.importeNeto

    // Las ordenes que se ofrecen para este renglon: las que tienen su
    // articulo, y la que ya tiene aunque hoy no figure (por ejemplo, si se
    // facturo en Tango mientras tanto).
    const candidatas = [...(oferta?.candidatasPorRenglon[l.orden] ?? [])]
    if (ocActual && !candidatas.includes(ocActual)) candidatas.unshift(ocActual)

    return { l, neto, imputados, ocActual, esCargo, candidatas, faltante: sinOrden.get(l.orden) ?? null }
  })

  if (lineas.length === 0) {
    return (
      <section className={styles.tarjeta}>
        <div className={styles.encabezado}>
          <h3 className={styles.titulo}>Renglones</h3>
        </div>
        <p className={styles.vacio}>
          No se leyeron renglones {esRemito ? 'de este remito' : 'de esta factura'}. Reprocesá el
          comprobante para poder imputarle una orden de compra.
        </p>
      </section>
    )
  }

  return (
    <>
      <section className={styles.tarjeta}>
        <div className={styles.encabezado}>
          <h3 className={styles.titulo}>Renglones</h3>
          <span className={styles.resumen}>
            {lineas.length} renglón(es) ·{' '}
            {filas.filter((f) => f.ocActual !== null || f.esCargo).length} con orden o cargo
          </span>
        </div>

        {/* Lo que vale para todos los renglones a la vez. */}
        {!codProvee && (
          <p className={styles.avisoTabla}>
            Primero hay que resolver el proveedor: sin él no hay órdenes de compra contra qué imputar.
          </p>
        )}
        {errorCarga && (
          <p className={`${styles.avisoTabla} ${styles.avisoError}`}>
            No se pudieron buscar las órdenes de compra: {errorCarga}
          </p>
        )}
        {!errorCarga && oferta !== null && codProvee && oferta.todas.length === 0 && (
          <p className={styles.avisoTabla}>
            Este proveedor no tiene órdenes de compra con saldo pendiente de{' '}
            {esRemito ? 'recibir' : 'facturar'}.
          </p>
        )}

        <div className={styles.tabla}>
          <div className={`${styles.fila} ${styles.grupos}`}>
            <span className={styles.grupoFactura}>
              {esRemito ? 'Remito' : 'Factura'} · leído por la IA
            </span>
            <span className={styles.grupoTango}>En Tango</span>
            <span className={styles.grupoOc}>Orden de compra</span>
          </div>
          <div className={`${styles.fila} ${styles.header}`}>
            <span>#</span>
            <span>Código</span>
            <span>Descripción</span>
            <span className={styles.der}>Cant.</span>
            <span className={styles.der} title="El precio unitario tal como está impreso">
              P. unit.
            </span>
            <span className={styles.der} title="Lo que cobra de verdad: el subtotal, con el descuento general aplicado si lo hay">
              Importe
            </span>
            <span>Artículo</span>
            <span
              className={styles.der}
              title={`Lo que la orden tiene pendiente de ${esRemito ? 'recibir' : 'facturar'} de ese artículo`}
            >
              Cant. OC
            </span>
            <span className={styles.der}>Precio OC</span>
            <span className={styles.celdaOc}>OC</span>
          </div>

          {filas.map(({ l, neto, imputados, ocActual, esCargo, candidatas, faltante }) => (
            <div key={l.orden} className={`${styles.fila} ${styles.renglon}`}>
              <span className={`${styles.mono} ${styles.tenue}`}>{l.orden}</span>
              <span className={`${styles.mono} ${styles.codigo}`}>{l.codigo ?? '—'}</span>
              <span className={styles.descripcion}>{l.descripcion ?? '—'}</span>
              <span className={`${styles.mono} ${styles.der}`}>
                {l.cantidad === null ? '—' : formatCantidad(parsearImporteONulo(l.cantidad))}
              </span>
              <span className={`${styles.mono} ${styles.der}`}>
                {neto ? formatMoneda(neto.precioImpreso) : (l.precioImpreso ?? '—')}
                {neto !== null && neto.descuentoPorc > 0.005 && (
                  <span className={styles.descuento} title={`Precio neto ${formatMoneda(neto.precioNeto)}`}>
                    −{formatCantidad(Math.round(neto.descuentoPorc * 100) / 100)}%
                  </span>
                )}
              </span>
              <span className={`${styles.mono} ${styles.der} ${styles.fuerte}`}>
                {neto ? formatMoneda(neto.importeNeto) : (l.subtotalImpreso ?? '—')}
              </span>

              {/* El articulo de Tango con la cantidad pendiente y el precio de
                  la OC, uno por articulo: un renglon desglosado por talle son
                  varios. Las tres columnas comparten la grilla de la tabla
                  (subgrid) para que cada articulo quede alineado con SU
                  cantidad y SU precio aunque la descripcion ocupe dos lineas
                  (2026-10-14, pedido del usuario). */}
              <span className={styles.tango}>
                {imputados.length > 0 ? (
                  imputados.map(({ r, precioOc, difiere, pendienteOc, excede }) => (
                    <Fragment key={r.id}>
                      <span className={styles.articulo}>
                        <span className={styles.mono}>{r.codigoFinal ?? r.codigo ?? '—'}</span>
                        <span className={styles.articuloDesc}>{r.descripcion ?? ''}</span>
                      </span>
                      <span
                        className={`${styles.mono} ${styles.der} ${excede ? styles.difiere : styles.tenue}`}
                        title={
                          excede
                            ? esRemito
                              ? 'El remito entrega más de lo que la orden tiene pendiente de recibir.'
                              : 'La factura cobra más de lo que la orden tiene pendiente.'
                            : undefined
                        }
                      >
                        {pendienteOc === null ? '—' : formatCantidad(pendienteOc)}
                        {excede && <span className={styles.marca}>!</span>}
                      </span>
                      <span
                        className={`${styles.mono} ${styles.der} ${difiere ? styles.difiere : styles.tenue}`}
                        title={
                          difiere
                            ? 'El precio de la orden no es el que cobra la factura. Se registra el de la factura.'
                            : undefined
                        }
                      >
                        {precioOc === null ? '—' : formatMoneda(precioOc)}
                        {difiere && <span className={styles.marca}>≠</span>}
                      </span>
                    </Fragment>
                  ))
                ) : faltante && faltante.equivalencias.length > 0 ? (
                  // Una linea desglosada por talle: el codigo pelado no es
                  // ningun articulo, cada talle es uno. Se muestran todos,
                  // igual que quedan despues de imputar la orden.
                  <>
                    {faltante.equivalencias.map((e) => (
                      <Fragment key={e.codArticu}>
                        <span className={styles.articulo}>
                          <span className={styles.mono}>{e.codArticu}</span>
                          <span className={styles.articuloDesc}>{e.descripcion}</span>
                        </span>
                        <span className={`${styles.mono} ${styles.der} ${styles.tenue}`}>—</span>
                        <span className={`${styles.mono} ${styles.der} ${styles.tenue}`}>—</span>
                      </Fragment>
                    ))}
                    {!faltante.hayCandidata && (
                      <span className={`${styles.alertaNota} ${styles.anchoTango}`}>
                        sin pendiente en ninguna OC
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className={styles.articulo}>
                      {faltante?.reconocidoComo ? (
                        <>
                          <span className={styles.mono}>{faltante.reconocidoComo.codArticu}</span>
                          <span className={styles.articuloDesc}>{faltante.reconocidoComo.descripcion}</span>
                          {faltante.hayCandidata && !soloLectura && (
                            // La columna OC puede quedar fuera de la vista
                            // con el PDF al lado: se dice aca que falta.
                            <span className={styles.notaOc}>falta elegir la OC (columna OC →)</span>
                          )}
                          {!faltante.hayCandidata && (
                            <span className={styles.alertaNota}>
                              {faltante.reconocidoComo.escala === 'base'
                                ? 'artículo base: le falta el color o el talle'
                                : 'sin pendiente en ninguna OC'}
                            </span>
                          )}
                        </>
                      ) : faltante && faltante.codigo === '' ? (
                        <span className={styles.alerta}>Sin vincular a un artículo</span>
                      ) : faltante && !faltante.hayCandidata ? (
                        <span className={styles.alerta}>No se reconoce en Tango</span>
                      ) : (
                        <span className={styles.tenue}>—</span>
                      )}
                    </span>
                    <span className={`${styles.mono} ${styles.der} ${styles.tenue}`}>—</span>
                    <span className={`${styles.mono} ${styles.der} ${styles.tenue}`}>—</span>
                  </>
                )}
              </span>

              <span className={styles.celdaOc}>
                {esCargo ? (
                  <span className={styles.cargo} title="Cargo del proveedor: se registra sin orden de compra">
                    Cargo · sin OC
                  </span>
                ) : soloLectura ? (
                  <span className={styles.mono}>{ocActual?.trim() ?? '—'}</span>
                ) : (
                  <select
                    className={`${styles.selectOc} ${ocActual ? '' : styles.selectVacio}`}
                    value={ocActual ?? ''}
                    disabled={pendiente || oferta === null || (candidatas.length === 0 && !ocActual)}
                    onChange={(e) => elegir(l.orden, e.target.value)}
                    title={
                      ocActual && fechaDe.get(ocActual)
                        ? `Emitida ${formatFecha(fechaDe.get(ocActual)!.fechaEmision)} · ${formatMoneda(fechaDe.get(ocActual)!.total)}`
                        : undefined
                    }
                  >
                    <option value="">
                      {oferta === null
                        ? 'Buscando…'
                        : ocActual
                          ? 'Quitar la OC'
                          : candidatas.length === 0
                            ? 'Ninguna OC lo tiene'
                            : 'Elegir OC…'}
                    </option>
                    {candidatas.map((oc) => (
                      <option key={oc} value={oc}>
                        {oc.trim()}
                        {fechaDe.get(oc)?.fechaEmision ? ` · ${formatFecha(fechaDe.get(oc)!.fechaEmision)}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </span>

              {/* Lo que tiene este renglon y como se arregla, en la misma
                  fila: hasta el 2026-10-14 era una tarjeta aparte debajo de
                  la tabla que repetia lo que dice la columna de Tango. */}
              <ProblemaRenglon
                comprobanteId={comprobanteId}
                codProvee={codProvee}
                oferta={oferta}
                orden={l.orden}
                onRecargar={cargar}
                soloLectura={soloLectura}
                // Ensenar una descripcion se permite siempre: es
                // conocimiento del proveedor, no un cambio de este
                // comprobante (2026-10-07).
                permitirVincular
              />
            </div>
          ))}

          {!esRemito && (
          <div className={`${styles.fila} ${styles.total}`}>
            <span />
            <span />
            <span className={styles.totalEtiqueta}>Total renglones</span>
            <span />
            <span />
            <span className={`${styles.mono} ${styles.der} ${styles.fuerte} ${resultado.ok ? styles.coincide : styles.error}`}>
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
            <span />
            <span className={`${styles.mono} ${styles.der} ${hayDiferencias ? styles.difiere : styles.tenue}`}>
              {formatMoneda(totalOc)}
            </span>
            <span className={styles.celdaOc} />
          </div>
          )}
        </div>

        {esRemito ? (
          <p className={styles.explicacion}>
            Cada renglón entra al depósito 01 y descuenta lo pendiente de recibir de su orden.
          </p>
        ) : (
          <p className={`${styles.explicacion} ${resultado.ok ? '' : styles.explicacionError}`}>
            {describirDescuento(resultado)}
            {hayDiferencias && ' Hay precios distintos a los de la orden: se registran los de la factura.'}
          </p>
        )}
      </section>

      {pregunta && (
        <div className={styles.overlay} onClick={() => setPregunta(null)}>
          <div
            className={styles.caja}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.key === 'Escape' && setPregunta(null)}
          >
            <h4 className={styles.cajaTitulo}>
              ¿La orden <span className={styles.mono}>{pregunta.nOrdenCo.trim()}</span> va para todos
              los renglones?
            </h4>
            <p className={styles.cajaTexto}>
              Se imputa a cada renglón que la orden tenga pendiente. Los que no estén en ella quedan
              sin OC, para elegirles otra.
            </p>
            <div className={styles.cajaBotones}>
              <button type="button" className={styles.secundario} onClick={() => setPregunta(null)}>
                Cancelar
              </button>
              <button
                type="button"
                className={styles.secundario}
                onClick={() => {
                  imputarUno(pregunta.pdfOrden, pregunta.nOrdenCo)
                  setPregunta(null)
                }}
              >
                Solo a este renglón
              </button>
              <button
                type="button"
                className={styles.primario}
                autoFocus
                onClick={() => {
                  imputarATodos(pregunta.pdfOrden, pregunta.nOrdenCo)
                  setPregunta(null)
                }}
              >
                Sí, a todos
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
