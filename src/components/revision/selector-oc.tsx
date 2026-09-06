'use client'

import { useEffect, useState, useTransition } from 'react'
import { listarOcDelProveedor, imputarOrdenCompra } from '@/server/app/acciones'
import type { OrdenCompra } from '@/server/tango/ordenesCompra'
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
 * Se ofrecen solo las OC del proveedor con `PENDIENTE_FACTURAR > 0`, sin
 * mirar el estado: lo que decide si se le puede facturar algo a una OC es
 * que le quede algo, no cómo esté rotulada.
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
  const [ocs, setOcs] = useState<OrdenCompra[] | null>(null)
  const [abierto, setAbierto] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  useEffect(() => {
    if (!codProvee) {
      setOcs([])
      return
    }
    let vigente = true
    listarOcDelProveedor(codProvee)
      .then((r) => vigente && setOcs(r))
      .catch(() => vigente && setOcs([]))
    return () => {
      vigente = false
    }
  }, [codProvee])

  const elegir = (oc: OrdenCompra) =>
    arrancar(async () => {
      try {
        const { renglones } = await imputarOrdenCompra(comprobanteId, oc.nOrdenCo)
        toast(`Orden de compra ${oc.nOrdenCo.trim()} imputada — ${renglones} renglón(es)`)
        setAbierto(false)
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo imputar la orden de compra.')
      }
    })

  const lista = ocs ?? []
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
          {ocs === null && <p className={styles.vacio}>Buscando órdenes de compra…</p>}
          {ocs !== null && lista.length === 0 && (
            <p className={styles.vacio}>
              Este proveedor no tiene órdenes de compra con saldo pendiente de facturar.
            </p>
          )}
          <ul className={styles.lista}>
            {lista.map((oc) => (
              <li key={oc.nOrdenCo}>
                <button
                  type="button"
                  className={styles.opcion}
                  disabled={pendiente}
                  onClick={() => elegir(oc)}
                >
                  <span className={styles.numero}>{oc.nOrdenCo.trim()}</span>
                  <span className={styles.meta}>
                    {oc.fechaEmision ? oc.fechaEmision.toLocaleDateString('es-AR') : '—'} ·{' '}
                    {oc.descripcionEstado} · {oc.renglones.length} renglón(es) pendiente(s)
                  </span>
                  <span className={styles.importe}>{formatMoneda(oc.total)}</span>
                </button>
                <div className={styles.detalle}>
                  {oc.renglones.map((r) => (
                    <div key={r.nRenglOc} className={styles.fila}>
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
