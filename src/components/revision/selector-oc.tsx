'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import {
  listarOcParaComprobante,
  imputarOrdenCompra,
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
 * está cargada en Tango: reemplaza al remito como origen del detalle
 * (decisión del usuario). Al elegirla, los renglones del comprobante pasan
 * a ser los que la OC tiene pendientes de facturar.
 *
 * Y desde 2026-09-07 no se ofrecen todas las OC del proveedor sino solo las
 * que contienen los artículos que la factura cobra, emparejando el código
 * impreso contra `CPA15.COD_SINONI`. Cuando no empareja ninguna se ofrecen
 * todas con un aviso: es preferible que el operador tenga que mirar a que
 * la pantalla lo deje sin poder imputar nada.
 */
export function SelectorOc({
  comprobanteId,
  codProvee,
  ocImputada,
  soloLectura = false,
}: {
  comprobanteId: number
  /** El proveedor ya resuelto. Sin él no hay contra qué buscar. */
  codProvee: string | null
  /** El número de OC que ya tiene imputada, si tiene. */
  ocImputada: string | null
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
      .catch(() => setOferta({ ocs: [], filtrada: false, sinResolver: [], articulosDisponibles: [] }))
  }, [comprobanteId, codProvee])

  useEffect(cargar, [cargar])

  const elegir = (nOrdenCo: string) =>
    arrancar(async () => {
      try {
        const { renglones } = await imputarOrdenCompra(comprobanteId, nOrdenCo)
        toast(`Orden de compra ${nOrdenCo.trim()} imputada — ${renglones} renglón(es)`)
        setAbierto(false)
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo imputar la orden de compra.')
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

  const lista = oferta?.ocs ?? []
  // Mostrar la lista de entrada mientras no haya ninguna imputada: es el
  // paso que el operador tiene que dar sí o sí, esconderlo detrás de un
  // botón sería una vuelta de más en la pantalla donde pasa el día.
  const mostrandoLista = !soloLectura && (abierto || !ocImputada)

  return (
    <section className={styles.tarjeta}>
      <div className={styles.encabezado}>
        <h3 className={styles.titulo}>Orden de compra</h3>
        {ocImputada && !soloLectura && (
          <button type="button" className={styles.cambiar} onClick={() => setAbierto((v) => !v)}>
            {abierto ? 'Cancelar' : 'Cambiar'}
          </button>
        )}
      </div>

      {ocImputada ? (
        <p className={styles.imputada}>
          Imputada a <span className={styles.numero}>{ocImputada.trim()}</span>
        </p>
      ) : (
        <p className={styles.aviso}>
          Esta factura todavía no está imputada a ninguna orden de compra.
        </p>
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

          {oferta !== null && lista.length > 0 && !oferta.filtrada && (
            <p className={styles.sinMatch}>
              No se pudo emparejar ningún artículo de la factura con estas órdenes. Están todas
              las que tienen saldo pendiente: revisá cuál corresponde.
            </p>
          )}

          {oferta !== null && oferta.sinResolver.length > 0 && (
            <div className={styles.enseñar}>
              <p className={styles.enseñarTitulo}>
                {oferta.sinResolver.length === 1
                  ? 'Este código de la factura no se reconoce:'
                  : 'Estos códigos de la factura no se reconocen:'}
              </p>
              {oferta.sinResolver.map((codigo) => (
                <div key={codigo} className={styles.enseñarFila}>
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
              <p className={styles.enseñarNota}>
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
                  disabled={pendiente}
                  onClick={() => elegir(oc.nOrdenCo)}
                >
                  <span className={styles.numero}>{oc.nOrdenCo.trim()}</span>
                  <span className={styles.meta}>
                    {oc.fechaEmision ? oc.fechaEmision.toLocaleDateString('es-AR') : '—'} ·{' '}
                    {oc.descripcionEstado} · {oc.renglones.length} renglón(es) pendiente(s)
                  </span>
                  <span className={styles.importe}>{formatMoneda(oc.total)}</span>
                </button>
                <div className={styles.detalle}>
                  {oc.renglones.map((r) => {
                    const coincide = oc.articulosQueCoinciden.includes(r.codArticu.toUpperCase())
                    return (
                      <div
                        key={r.nRenglOc}
                        className={coincide ? `${styles.fila} ${styles.filaCoincide}` : styles.fila}
                      >
                        <span className={styles.marca}>{coincide ? '✓' : ''}</span>
                        <span className={styles.codigo}>{r.codArticu}</span>
                        <span className={styles.desc}>{r.descripcion}</span>
                        <span className={styles.cant}>
                          {formatCantidad(r.pendienteFacturar)} pend.
                        </span>
                      </div>
                    )
                  })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
