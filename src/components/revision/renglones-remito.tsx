'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  prepararRemito,
  elegirFacturaRenglon,
  elegirFacturaRemito,
  marcarRemitoSinReferencia,
} from '@/server/app/acciones/remitos'
import {
  asociarCodigoProveedor,
  vincularDescripcionArticulo,
  buscarArticuloPorCodigo,
} from '@/server/app/acciones/articulos'
import type { OfertaFacturasRemito } from '@/server/app/remitoFactura'
import type { RenglonGuardado, SeriePdfGuardada } from '@/server/app/detalle'
import { claveRenglonFactura, claveFactura, type CandidatoFactura } from '@/lib/remitoFactura'
import { formatCantidad, formatFecha, parsearImporteONulo } from '@/lib/formato'
import { useToast } from '@/components/toast/toast-provider'
import { BuscadorArticulos } from './buscador-articulos'
import { SeriesLeidas } from './series-leidas'
import styles from './renglones-remito.module.css'

/**
 * Los renglones de un REMITO de proveedor y la factura a la que se vincula
 * cada uno (2026-11-16, pedido del usuario: el remito se vincula a una
 * factura ya registrada en Tango, no a una orden de compra).
 *
 * Una fila por renglón del papel, con el artículo de Tango que le
 * corresponde y la factura que recibe. La app la propone sola (la que cubre
 * más renglones; entre iguales, la más vieja) y el operador la cambia en la
 * fila, o elige una para todo el remito arriba. La orden de compra no se
 * elige: si la factura se imputó a una, el remito la hereda al registrar.
 *
 * Si algún renglón no tiene factura --o el proveedor no tiene ninguna con
 * mercadería sin recibir--, un cartel lo dice y deja confirmar que se grabe
 * sin comprobante de referencia.
 */
export function RenglonesRemito({
  comprobanteId,
  codProvee,
  renglones,
  seriesPdf = [],
  soloLectura = false,
  version = 0,
}: {
  comprobanteId: number
  codProvee: string | null
  /** PHF_RENGLON: lo que se va a grabar, con la factura de cada uno. */
  renglones: RenglonGuardado[]
  seriesPdf?: SeriePdfGuardada[]
  soloLectura?: boolean
  version?: number
}) {
  const [oferta, setOferta] = useState<OfertaFacturasRemito | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()
  const router = useRouter()

  const cargar = useCallback(() => {
    if (soloLectura) return
    setError(null)
    prepararRemito(comprobanteId)
      .then((o) => {
        setOferta(o)
        // prepararRemito pudo crear renglones o proponer facturas: la
        // pagina tiene que volver a leerlos.
        router.refresh()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'No se pudieron buscar las facturas.'))
  }, [comprobanteId, soloLectura, router])

  useEffect(cargar, [cargar, version])

  const accion = (fn: () => Promise<unknown>, ok: string) =>
    arrancar(async () => {
      try {
        await fn()
        toast(ok)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo guardar.')
      }
    })

  const porPdf = new Map(renglones.filter((r) => r.pdfOrden !== null).map((r) => [r.pdfOrden!, r]))
  const lineas = oferta?.lineas ?? []
  const sinFactura = renglones.filter((r) => !r.factura)
  // Sin factura pero con orden de compra (2026-11-18): van contra la orden y
  // no piden confirmar nada.
  const conSoloOc = sinFactura.filter((r) => r.ocNOrdenCo)
  const sinNada = sinFactura.filter((r) => !r.ocNOrdenCo)
  const sinReferencia = oferta?.sinReferencia ?? false
  const hayFacturas = (oferta?.facturas.length ?? 0) > 0
  // La factura que tienen todos los renglones, para mostrarla en el selector general.
  const facturasUsadas = [...new Set(renglones.filter((r) => r.factura).map((r) => claveFactura(r.factura!)))]
  const facturaGeneral = facturasUsadas.length === 1 && sinFactura.length === 0 ? facturasUsadas[0] : ''

  if (soloLectura) {
    return (
      <section className={styles.tarjeta}>
        <div className={styles.encabezado}>
          <h3 className={styles.titulo}>Renglones</h3>
        </div>
        {renglones.map((r) => (
          <div key={r.id} className={styles.filaLectura}>
            <span className={styles.mono}>{r.codigoFinal ?? r.codigo ?? '—'}</span>
            <span>{r.descripcion ?? ''}</span>
            <span className={`${styles.mono} ${styles.der}`}>{formatCantidad(parsearImporteONulo(r.cantidad))}</span>
            <span className={styles.mono}>
              {r.factura
                ? `Factura ${r.factura.nComp ?? ''}`
                : r.ocNOrdenCo
                  ? `Orden de compra ${r.ocNOrdenCo.trim()}`
                  : 'Sin comprobante de referencia'}
            </span>
          </div>
        ))}
      </section>
    )
  }

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Renglones</h3>
        <span className={styles.resumen}>
          {renglones.length} renglón(es) · {renglones.length - sinFactura.length} con factura
          {conSoloOc.length > 0 ? ` · ${conSoloOc.length} contra la orden de compra` : ''}
        </span>
      </div>

      {!codProvee && (
        <p className={styles.aviso}>Primero hay que resolver el proveedor: sin él no hay facturas para vincular.</p>
      )}
      {error && <p className={`${styles.aviso} ${styles.avisoError}`}>{error}</p>}

      {/* La factura para todo el remito: el caso de casi todos. */}
      {oferta && hayFacturas && (
        <div className={styles.general}>
          <span className={styles.etiqueta}>Factura de referencia</span>
          <select
            className={styles.select}
            value={facturaGeneral}
            disabled={pendiente}
            onChange={(e) => {
              const f = oferta.facturas.find((x) => claveFactura(x) === e.target.value)
              if (!f) return
              accion(
                async () => {
                  const r = await elegirFacturaRemito(comprobanteId, { tcompInC: f.tcompInC, ncompInC: f.ncompInC })
                  if (r.cubiertos < r.total) {
                    toast(`La factura ${f.nComp} cubre ${r.cubiertos} de ${r.total} renglón(es).`)
                  }
                },
                `Factura ${f.nComp} elegida para el remito`,
              )
            }}
          >
            <option value="">{facturasUsadas.length > 1 ? 'Varias facturas' : 'Elegir factura…'}</option>
            {oferta.facturas.map((f) => (
              <option key={claveFactura(f)} value={claveFactura(f)}>
                {f.nComp}
                {f.fechaEmision ? ` · ${formatFecha(f.fechaEmision)}` : ''} · {f.renglones} renglón(es) sin recibir
              </option>
            ))}
          </select>
        </div>
      )}

      {/* El cartel: no hay factura para todo, y se puede grabar igual. */}
      {oferta && conSoloOc.length > 0 && (
        <p className={styles.aviso}>
          {conSoloOc.length === renglones.length ? 'El remito' : `${conSoloOc.length} renglón(es)`} todavía sin
          factura: se {conSoloOc.length === 1 ? 'vincula' : 'vinculan'} a la orden de compra
          {' '}{[...new Set(conSoloOc.map((r) => r.ocNOrdenCo!.trim()))].join(', ')} y{' '}
          {conSoloOc.length === 1 ? 'queda' : 'quedan'} pendiente(s) de facturar. Cuando llegue la factura de esa
          orden, se vincula a este remito.
        </p>
      )}

      {oferta && renglones.length > 0 && sinNada.length > 0 && (
        <div className={sinReferencia ? styles.cartelConfirmado : styles.cartel}>
          <p className={styles.cartelTexto}>
            {!hayFacturas && conSoloOc.length === 0
              ? 'Este proveedor no tiene ninguna factura registrada en Tango con mercadería sin recibir: el remito no tiene a qué factura vincularse.'
              : sinNada.length === renglones.length
                ? 'Ningún renglón del remito tiene factura ni orden de compra de referencia.'
                : `${sinNada.length} renglón(es) no tienen factura ni orden de compra de referencia.`}{' '}
            {sinReferencia
              ? 'Se van a grabar sin comprobante de referencia: entran a stock sin vincularse a ninguna factura ni orden de compra.'
              : 'Podés grabarlos sin comprobante de referencia: entran a stock sin vincularse a ninguna factura ni orden de compra.'}
          </p>
          <label className={styles.confirmar}>
            <input
              type="checkbox"
              checked={sinReferencia}
              disabled={pendiente}
              onChange={(e) =>
                accion(
                  () => marcarRemitoSinReferencia(comprobanteId, e.target.checked),
                  e.target.checked ? 'Se graba sin comprobante de referencia' : 'Confirmación retirada',
                )
              }
            />
            Grabar sin comprobante de referencia
          </label>
        </div>
      )}

      {lineas.length === 0 && oferta && (
        <p className={styles.vacio}>No se leyeron renglones de este remito. Reprocesá el comprobante.</p>
      )}

      {lineas.length > 0 && (
        <div className={styles.tabla}>
          <div className={`${styles.fila} ${styles.header}`}>
            <span>#</span>
            <span>Código</span>
            <span>Descripción</span>
            <span className={styles.der}>Cant.</span>
            <span>Artículo en Tango</span>
            <span>Factura</span>
            <span className={styles.der} title="Lo que el renglón de la factura tiene sin recibir">
              Falta recibir
            </span>
            <span>OC</span>
          </div>
          {lineas.map((l) => {
            const r = porPdf.get(l.pdfOrden) ?? null
            const candidatos = r ? (oferta?.candidatosPorRenglon[r.id] ?? []) : []
            const actual = r?.factura ? claveRenglonFactura(r.factura) : ''
            const elegido = candidatos.find((c) => claveRenglonFactura(c) === actual) ?? null
            const falta = r?.factura?.faltaRem != null ? Number(r.factura.faltaRem) : null
            const cantidad = parsearImporteONulo(r?.cantidad ?? null) ?? l.cantidad
            const excede = falta !== null && cantidad - falta > 0.00005
            return (
              <div key={l.pdfOrden} className={`${styles.fila} ${styles.renglon}`}>
                <span className={`${styles.mono} ${styles.tenue}`}>{l.pdfOrden}</span>
                <span className={`${styles.mono} ${styles.codigo}`}>{l.codigoImpreso ?? '—'}</span>
                <span className={styles.descripcion}>{l.descripcion ?? '—'}</span>
                <span className={`${styles.mono} ${styles.der}`}>{formatCantidad(cantidad)}</span>
                <span className={styles.articulo}>
                  {r && (r.codigoFinal ?? r.codigo) ? (
                    <>
                      <span className={styles.mono}>{r.codigoFinal ?? r.codigo}</span>
                      <span className={styles.tenue}>{r.descripcion ?? ''}</span>
                    </>
                  ) : (
                    <VincularArticulo
                      comprobanteId={comprobanteId}
                      codProvee={codProvee}
                      codigoImpreso={l.codigoImpreso}
                      descripcion={l.descripcion}
                      onListo={cargar}
                    />
                  )}
                </span>
                <span>
                  {r && (r.codigoFinal ?? r.codigo) ? (
                    <select
                      className={`${styles.select} ${actual ? '' : styles.selectVacio}`}
                      value={actual}
                      disabled={pendiente || !oferta}
                      onChange={(e) => {
                        const c = candidatos.find((x) => claveRenglonFactura(x) === e.target.value) ?? null
                        accion(
                          () =>
                            elegirFacturaRenglon(
                              comprobanteId,
                              r.id,
                              c ? { tcompInC: c.tcompInC, ncompInC: c.ncompInC, nRenglC: c.nRenglC } : null,
                            ),
                          c ? `Factura ${c.nComp} elegida para el renglón ${l.pdfOrden}` : `Renglón ${l.pdfOrden} sin factura`,
                        )
                      }}
                    >
                      <option value="">{candidatos.length === 0 && !actual ? 'Ninguna factura lo tiene' : 'Sin factura'}</option>
                      {r.factura && !elegido && (
                        <option value={actual}>{r.factura.nComp ?? 'Factura elegida'}</option>
                      )}
                      {candidatos.map((c) => (
                        <option key={claveRenglonFactura(c)} value={claveRenglonFactura(c)}>
                          {describirCandidato(c)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className={styles.tenue}>—</span>
                  )}
                </span>
                <span
                  className={`${styles.mono} ${styles.der} ${excede ? styles.excede : styles.tenue}`}
                  title={excede ? 'El remito recibe más de lo que la factura tiene sin recibir.' : undefined}
                >
                  {falta === null ? '—' : formatCantidad(falta)}
                  {excede && ' !'}
                </span>
                <span
                  className={`${styles.mono} ${styles.tenue}`}
                  title={
                    !r?.factura && r?.ocNOrdenCo
                      ? `Sin factura: va contra el renglón ${r.ocNRenglOc} de la orden, que tiene ${formatCantidad(parsearImporteONulo(r.ocPendiente))} pendiente(s) de recibir.`
                      : undefined
                  }
                >
                  {elegido?.oc
                    ? elegido.oc.nOrdenCo.trim()
                    : !r?.factura && r?.ocNOrdenCo
                      ? `${r.ocNOrdenCo.trim()} · pend. ${formatCantidad(parsearImporteONulo(r.ocPendiente))}`
                      : '—'}
                </span>
                <SeriesLeidas
                  series={seriesPdf.filter((s) => s.pdfOrden === l.pdfOrden)}
                  cantidad={l.cantidad}
                />
              </div>
            )
          })}
        </div>
      )}

      <p className={styles.explicacion}>
        Cada renglón entra al depósito de su orden de compra (01 si no tiene). Contra una factura, se vincula a
        ella y, si la factura se imputó a una orden de compra, descuenta lo pendiente de recibir de esa orden.
        Sin factura, va contra la orden de compra que tiene el artículo pendiente de recibir y queda pendiente de
        facturar.
      </p>
    </section>
  )
}

function describirCandidato(c: CandidatoFactura): string {
  return (
    `${c.nComp}` +
    (c.fechaEmision ? ` · ${formatFecha(c.fechaEmision)}` : '') +
    ` · renglón ${c.nRenglC} · faltan ${formatCantidad(c.faltaRem)}`
  )
}

/**
 * Un renglón del papel que no se reconoce en Tango: el operador escribe el
 * código o lo busca. Si el papel trae código, se enseña como sinónimo del
 * proveedor (CPA15); si no, se aprende la descripción. Las dos cosas valen
 * para los comprobantes que vengan, igual que en la factura.
 */
function VincularArticulo({
  comprobanteId,
  codProvee,
  codigoImpreso,
  descripcion,
  onListo,
}: {
  comprobanteId: number
  codProvee: string | null
  codigoImpreso: string | null
  descripcion: string | null
  onListo: () => void
}) {
  const [codigo, setCodigo] = useState('')
  const [buscando, setBuscando] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  const vincular = (codArticu: string) =>
    arrancar(async () => {
      try {
        if (!codProvee) throw new Error('Primero hay que resolver el proveedor.')
        if ((codigoImpreso ?? '').trim()) {
          await asociarCodigoProveedor(comprobanteId, codProvee, codArticu, codigoImpreso!.trim())
        } else if ((descripcion ?? '').trim()) {
          await vincularDescripcionArticulo(comprobanteId, codProvee, descripcion!.trim(), codArticu)
        } else {
          throw new Error('El renglón no tiene código ni descripción para recordar.')
        }
        toast(`Renglón vinculado a ${codArticu}`)
        setCodigo('')
        onListo()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo vincular el artículo.')
      }
    })

  const confirmar = () =>
    arrancar(async () => {
      const art = await buscarArticuloPorCodigo(codigo.trim()).catch(() => null)
      if (!art) {
        toast(`No existe el artículo ${codigo.trim()}`)
        return
      }
      vincular(art.codArticu)
    })

  return (
    <span className={styles.vincular}>
      <span className={styles.alerta}>No se reconoce en Tango</span>
      <span className={styles.vincularControles}>
        <input
          className={styles.inputCodigo}
          type="text"
          placeholder="Código de Tango"
          value={codigo}
          disabled={pendiente}
          onChange={(e) => setCodigo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && codigo.trim()) {
              e.preventDefault()
              confirmar()
            }
          }}
        />
        <button type="button" className={styles.boton} disabled={pendiente || !codigo.trim()} onClick={confirmar}>
          Vincular
        </button>
        <button type="button" className={styles.boton} disabled={pendiente} onClick={() => setBuscando(true)}>
          Buscar…
        </button>
      </span>
      {buscando && (
        <BuscadorArticulos
          codProvee={codProvee}
          descripcionFactura={descripcion ?? codigoImpreso ?? ''}
          onElegir={(cod) => {
            setBuscando(false)
            vincular(cod)
          }}
          onCerrar={() => setBuscando(false)}
        />
      )}
    </span>
  )
}
