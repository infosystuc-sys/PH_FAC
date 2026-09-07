'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  listarOcParaComprobante,
  imputarOrdenCompra,
  desimputarOrdenCompra,
  asociarCodigoProveedor,
  type OfertaOc,
} from '@/server/app/acciones'
import { useToast } from '@/components/toast/toast-provider'
import { formatMoneda, formatCantidad } from '@/lib/formato'
import styles from './selector-oc.module.css'

/**
 * A qué orden de compra se imputa una factura de artículos.
 *
 * Desde 2026-09-06 toda factura de artículos se imputa a una OC, que ya
 * está cargada en Tango: reemplaza al remito como origen del precio y del
 * vínculo con Tango (decisión del usuario).
 *
 * Se ofrecen solo las OC que contienen los artículos que la factura cobra,
 * emparejando el código impreso contra `CPA15.COD_SINONI`. Cuando no
 * empareja ninguna se ofrecen todas con un aviso: es preferible que el
 * operador tenga que mirar a que la pantalla lo deje sin poder imputar.
 *
 * Admite varias órdenes: una factura puede repartirse entre dos, y hasta
 * que TODOS sus renglones tengan orden el comprobante no se registra. Los
 * que faltan se listan acá, que es donde el operador los resuelve --
 * imputando otra orden o enseñando el sinónimo.
 */
export function SelectorOc({
  comprobanteId,
  codProvee,
  soloLectura = false,
}: {
  comprobanteId: number
  /** El proveedor ya resuelto. Sin él no hay contra qué buscar. */
  codProvee: string | null
  soloLectura?: boolean
}) {
  const [oferta, setOferta] = useState<OfertaOc | null>(null)
  const [abierto, setAbierto] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  const cargar = useCallback(() => {
    if (!codProvee) {
      setOferta(null)
      return
    }
    listarOcParaComprobante(comprobanteId, codProvee)
      .then(setOferta)
      .catch(() =>
        setOferta({
          ocs: [],
          filtrada: false,
          sinResolver: [],
          articulosDisponibles: [],
          imputadas: [],
          sinOrden: [],
        }),
      )
  }, [comprobanteId, codProvee])

  useEffect(cargar, [cargar])

  const imputar = (nOrdenCo: string) =>
    arrancar(async () => {
      try {
        const { renglones, sinEmparejar } = await imputarOrdenCompra(
          comprobanteId,
          nOrdenCo,
          codProvee,
        )
        const resto =
          sinEmparejar > 0 ? ` — quedan ${sinEmparejar} renglón(es) sin orden` : ''
        toast(`Orden ${nOrdenCo.trim()} imputada: ${renglones} renglón(es)${resto}`)
        setAbierto(false)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo imputar la orden de compra.')
      }
    })

  const quitar = (nOrdenCo: string) =>
    arrancar(async () => {
      try {
        await desimputarOrdenCompra(comprobanteId, nOrdenCo)
        toast(`Orden ${nOrdenCo.trim()} quitada`)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo quitar la orden de compra.')
      }
    })

  const asociar = (codSinoni: string, codArticu: string) =>
    arrancar(async () => {
      try {
        await asociarCodigoProveedor(comprobanteId, codProvee!, codArticu, codSinoni)
        toast(`"${codSinoni}" asociado a ${codArticu}`)
        // La lista se rearma con el sinonimo nuevo: el filtro que antes no
        // encontraba nada ahora puede encontrar su OC.
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo asociar el código.')
      }
    })

  const imputadas = oferta?.imputadas ?? []
  const sinOrden = oferta?.sinOrden ?? []
  const lista = oferta?.ocs ?? []
  // La lista se muestra sola mientras falte cubrir algún renglón: es el paso
  // que el operador tiene que dar sí o sí, esconderlo detrás de un botón
  // sería una vuelta de más en la pantalla donde pasa el día. Una vez
  // cubierto todo, se abre solo si lo pide.
  const faltaCubrir = sinOrden.length > 0
  const mostrandoLista = !soloLectura && (abierto || faltaCubrir)

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Orden de compra</h3>
        {!soloLectura && imputadas.length > 0 && !faltaCubrir && (
          <button type="button" className={styles.cambiar} onClick={() => setAbierto((v) => !v)}>
            {abierto ? 'Cancelar' : 'Imputar otra'}
          </button>
        )}
      </div>

      {imputadas.length > 0 ? (
        <ul className={styles.imputadas}>
          {imputadas.map((oc) => (
            <li key={oc} className={styles.imputada}>
              <span className={styles.numero}>{oc.trim()}</span>
              {!soloLectura && (
                <button
                  type="button"
                  className={styles.quitar}
                  disabled={pendiente}
                  onClick={() => quitar(oc)}
                >
                  Quitar
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.aviso}>
          Esta factura todavía no está imputada a ninguna orden de compra.
        </p>
      )}

      {sinOrden.length > 0 && (
        <div className={styles.faltantes}>
          <p className={styles.faltantesTitulo}>
            {sinOrden.length === 1
              ? 'Un renglón de la factura no tiene orden de compra:'
              : `${sinOrden.length} renglones de la factura no tienen orden de compra:`}
          </p>
          {sinOrden.map((r) => (
            <div key={r.orden} className={styles.faltanteFila}>
              <span className={styles.codigo}>{r.codigo || '(sin código)'}</span>
              <span className={styles.cant}>{r.cantidad ?? '—'}</span>
            </div>
          ))}
          <p className={styles.faltantesNota}>
            No se puede registrar hasta que todos tengan la suya. Imputá otra orden, o asociá el
            código si es un artículo que la orden sí trae con otro nombre.
          </p>
        </div>
      )}

      {!codProvee && <p className={styles.vacio}>Primero hay que resolver el proveedor.</p>}

      {mostrandoLista && codProvee && (
        <>
          {oferta === null && <p className={styles.vacio}>Buscando órdenes de compra…</p>}

          {oferta !== null && lista.length === 0 && (
            <p className={styles.vacio}>
              Este proveedor no tiene órdenes de compra con saldo pendiente de facturar.
            </p>
          )}

          {/* Solo cuando queda algo por cubrir: si el operador abrio la lista
              con todo ya imputado, no hay nada que no haya emparejado. */}
          {oferta !== null && lista.length > 0 && !oferta.filtrada && faltaCubrir && (
            <p className={styles.sinMatch}>
              No se pudo emparejar ningún artículo de la factura con estas órdenes. Están todas
              las que tienen saldo pendiente: revisá cuál corresponde.
            </p>
          )}

          {oferta !== null && oferta.sinResolver.length > 0 && (
            <div className={styles.ensenar}>
              <p className={styles.ensenarTitulo}>
                {oferta.sinResolver.length === 1
                  ? 'Este código de la factura no se reconoce:'
                  : 'Estos códigos de la factura no se reconocen:'}
              </p>
              {oferta.sinResolver.map((codigo) => (
                <div key={codigo} className={styles.ensenarFila}>
                  <span className={styles.codigo}>{codigo}</span>
                  <select
                    className={styles.selectArticulo}
                    defaultValue=""
                    disabled={pendiente}
                    onChange={(e) => e.target.value && asociar(codigo, e.target.value)}
                  >
                    <option value="">¿A qué artículo corresponde?</option>
                    {oferta.articulosDisponibles.map((a) => (
                      <option key={a.codArticu} value={a.codArticu}>
                        {a.codArticu} · {a.descripcion}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <p className={styles.ensenarNota}>
                Se guarda en Tango y la próxima factura de este proveedor lo empareja sola.
              </p>
            </div>
          )}

          <ul className={styles.lista}>
            {lista.map((oc) => (
              <li key={oc.nOrdenCo}>
                <button
                  type="button"
                  className={styles.opcion}
                  disabled={pendiente || imputadas.includes(oc.nOrdenCo)}
                  onClick={() => imputar(oc.nOrdenCo)}
                >
                  <span className={styles.numero}>{oc.nOrdenCo.trim()}</span>
                  <span className={styles.meta}>
                    {oc.fechaEmision ? oc.fechaEmision.toLocaleDateString('es-AR') : '—'} ·{' '}
                    {oc.descripcionEstado} · {oc.renglones.length} renglón(es) pendiente(s)
                  </span>
                  <span className={styles.importe}>{formatMoneda(oc.total)}</span>
                </button>
                {/* Solo los renglones que esta factura cobra: el resto de la
                    orden no ayuda a decidir y son casi siempre muchos más. */}
                <div className={styles.detalle}>
                  {oc.renglones
                    .filter((r) => oc.articulosQueCoinciden.includes(r.codArticu.toUpperCase()))
                    .map((r) => (
                      <div key={r.nRenglOc} className={styles.fila}>
                        <span className={styles.marca}>✓</span>
                        <span className={styles.codigo}>{r.codArticu}</span>
                        <span className={styles.desc}>{r.descripcion}</span>
                        <span className={styles.cant}>
                          {formatCantidad(r.pendienteFacturar)} pend.
                        </span>
                      </div>
                    ))}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
