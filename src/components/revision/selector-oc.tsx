'use client'

import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  listarOcParaComprobante,
  imputarOrdenCompra,
  desimputarOrdenCompra,
  asociarCodigoProveedor,
  vincularDescripcionArticulo,
  marcarRenglonSinOc,
  buscarArticuloPorCodigo,
  type OfertaOc,
} from '@/server/app/acciones'
import type { ArticuloTango } from '@/server/tango/articulos'
import { useToast } from '@/components/toast/toast-provider'
import { formatMoneda, formatCantidad } from '@/lib/formato'
import { normalizarCodigo } from '@/lib/cotejoOc'
import { BuscadorArticulos } from './buscador-articulos'
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
/**
 * El campo donde el operador ESCRIBE el código de Tango (2026-10-08, pedido
 * del usuario). Para los proveedores que no imprimen código, que son los
 * que llegan acá, el operador casi siempre sabe cuál es y tipearlo es más
 * rápido que buscarlo.
 *
 * No vincula lo que se teclea: antes lo resuelve contra el maestro y avisa
 * si no existe. La comparación ignora mayúsculas, puntuación, espacios
 * interiores y ceros de adelante (ver `normalizarCodigo`), así que quien
 * escribe "26459 001 35" encuentra "26459  001 35"; lo que se guarda es
 * siempre el código tal como está en el maestro, no lo tecleado.
 */
function CampoCodigo({
  bloqueado,
  onResolver,
}: {
  bloqueado: boolean
  onResolver: (codArticu: string) => void
}) {
  const [codigo, setCodigo] = useState('')
  const [verificando, setVerificando] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirmar = async () => {
    const c = codigo.trim()
    if (c === '' || bloqueado || verificando) return
    setVerificando(true)
    setError(null)
    try {
      const art = await buscarArticuloPorCodigo(c)
      if (!art) {
        setError(`No existe el artículo ${c}`)
        return
      }
      setCodigo('')
      onResolver(art.codArticu)
    } catch {
      setError('No se pudo verificar el código.')
    } finally {
      setVerificando(false)
    }
  }

  return (
    <span className={styles.campoCodigo}>
      <input
        className={styles.inputCodigo}
        type="text"
        placeholder="Código de Tango"
        value={codigo}
        disabled={bloqueado || verificando}
        onChange={(e) => {
          setCodigo(e.target.value)
          if (error) setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void confirmar()
          }
        }}
      />
      <button
        type="button"
        className={styles.vincularBoton}
        disabled={bloqueado || verificando || codigo.trim() === ''}
        onClick={() => void confirmar()}
      >
        {verificando ? 'Verificando…' : 'Vincular'}
      </button>
      {error && <span className={styles.errorCodigo}>{error}</span>}
    </span>
  )
}

export function SelectorOc({
  comprobanteId,
  codProvee,
  soloLectura = false,
  permitirVincular = false,
}: {
  comprobanteId: number
  /** El proveedor ya resuelto. Sin él no hay contra qué buscar. */
  codProvee: string | null
  soloLectura?: boolean
  /**
   * Deja enseñar una descripción aunque el resto esté de solo lectura. Ver
   * `puedeVincular`: lo que se guarda es del proveedor, no del comprobante.
   */
  permitirVincular?: boolean
}) {
  const [oferta, setOferta] = useState<OfertaOc | null>(null)
  const [errorCarga, setErrorCarga] = useState<string | null>(null)
  const [abierto, setAbierto] = useState(false)
  // Renglones (por ORDEN del PDF) que el operador tildo "es un cargo" ANTES
  // de elegir el articulo del desplegable: se lee al elegir, para que el
  // vinculo se cree ya con SIN_OC=1 en el mismo paso. Sin esto, tildar la
  // opcion antes de elegir articulo no tenia nada que actualizar --no existe
  // fila en PHF_ARTICULO_PROVEEDOR todavia-- y quedaba en un no-op silencioso.
  const [comoCargo, setComoCargo] = useState<Set<number>>(new Set())
  // Que fila tiene abierta la ventana de busqueda. Una sola a la vez: es
  // modal. La clave lleva de que lista viene, porque el ORDEN del PDF se
  // repite entre los faltantes y los cargos.
  const [buscandoPara, setBuscandoPara] = useState<string | null>(null)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  // Vincular una descripcion con un articulo de Tango es conocimiento DEL
  // PROVEEDOR, no un cambio de este comprobante: se permite aunque el
  // comprobante este cerrado --registrado, o ya existente en Tango--
  // (2026-10-07, decision del usuario). Sin esto habia un circulo: los
  // proveedores que todavia se cargan a mano en Tango dejan todos sus
  // comprobantes en 'existente', y la app no podia aprender justamente
  // porque todavia no se la usaba para registrar.
  //
  // Es lo UNICO que se habilita. Imputar una orden, marcar un cargo,
  // corregir o registrar siguen bloqueados: eso si cambiaria el
  // comprobante. El server action ademas no toca sus renglones cuando esta
  // cerrado (ver comprobanteCerradoEn).
  const puedeVincular = !soloLectura || permitirVincular

  const cargar = useCallback(() => {
    if (!codProvee) {
      setOferta(null)
      return
    }
    setErrorCarga(null)
    listarOcParaComprobante(comprobanteId, codProvee)
      .then(setOferta)
      .catch((e: unknown) => {
        // Antes se tragaba el error y dejaba la tarjeta vacia, como si el
        // proveedor no tuviera ordenes: el operador no tenia forma de saber
        // que algo fallo (NEWSAN, 2026-09-18). Se muestra.
        setErrorCarga(e instanceof Error ? e.message : 'No se pudieron buscar las órdenes de compra.')
        setOferta({
          ocs: [],
          filtrada: false,
          sinResolver: [],
          articulosDisponibles: [],
          imputadas: [],
          sinOrden: [],
          codigosFactura: {},
          cargos: [],
        })
      })
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

  // Un renglon SIN codigo se vincula por su descripcion (2026-09-17): se
  // aprende para el proveedor y la lista se rearma, igual que con un
  // sinonimo.
  const vincular = (descripcion: string, codArticu: string, sinOc = false) =>
    arrancar(async () => {
      try {
        const { quedan } = await vincularDescripcionArticulo(comprobanteId, codProvee!, descripcion, codArticu, sinOc)
        toast(
          `"${descripcion}" vinculada a ${codArticu}` +
            (quedan > 0 ? ` — quedan ${quedan} renglón(es) por vincular` : ''),
        )
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo vincular el artículo.')
      }
    })

  // Marcar o desmarcar un renglon ya vinculado como cargo del proveedor.
  const marcarCargo = (descripcion: string, sinOc: boolean) =>
    arrancar(async () => {
      try {
        await marcarRenglonSinOc(comprobanteId, codProvee!, descripcion, sinOc)
        toast(
          sinOc
            ? `"${descripcion}" se registra sin orden de compra`
            : `"${descripcion}" vuelve a ir contra una orden de compra`,
        )
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo marcar el renglón.')
      }
    })

  const cargos = oferta?.cargos ?? []
  const imputadas = oferta?.imputadas ?? []
  const sinOrden = oferta?.sinOrden ?? []
  const lista = oferta?.ocs ?? []
  // Dos cosas distintas. Que un renglon no tenga orden imputada todavia no
  // es un problema si hay una orden que lo trae: falta imputarla, y esta
  // listada abajo. Problema es que ninguna orden lo tenga.
  const sinCandidata = sinOrden.filter((r) => !r.hayCandidata)
  const porImputar = sinOrden.filter((r) => r.hayCandidata)
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
          {porImputar.length > 0 && lista.length > 0 && ' Elegí la que corresponde de la lista.'}
        </p>
      )}

      {/* Los cargos del proveedor: se registran igual, sin orden de compra. */}
      {cargos.length > 0 && (
        <div className={styles.cargos}>
          <p className={styles.cargosTitulo}>
            {cargos.length === 1
              ? 'Este renglón se registra sin orden de compra:'
              : 'Estos renglones se registran sin orden de compra:'}
          </p>
          {cargos.map((c) => (
            <div key={c.orden} className={styles.cargoFila}>
              <span className={styles.codigo}>{c.codigo}</span>
              <span className={styles.descripcionFactura}>{c.descripcion ?? '—'}</span>
              <span className={styles.cant}>{c.cantidad ?? '—'}</span>
              {!soloLectura && c.descripcion && (
                <span className={styles.cargoAcciones}>
                  <button
                    type="button"
                    className={styles.buscarArticulo}
                    disabled={pendiente}
                    onClick={() => setBuscandoPara(`cargo:${c.orden}`)}
                  >
                    Cambiar artículo
                  </button>
                  {buscandoPara === `cargo:${c.orden}` && (
                    <BuscadorArticulos
                      codProvee={codProvee}
                      descripcionFactura={c.descripcion}
                      onElegir={(cod) => vincular(c.descripcion!, cod, true)}
                      onCerrar={() => setBuscandoPara(null)}
                    />
                  )}
                  <button
                    type="button"
                    className={styles.quitar}
                    disabled={pendiente}
                    onClick={() => marcarCargo(c.descripcion!, false)}
                  >
                    Va contra una OC
                  </button>
                </span>
              )}
            </div>
          ))}
          <p className={styles.cargosNota}>
            Entran en la factura y en el asiento con el precio del comprobante, sin consumir
            pendiente de ninguna orden. Se recuerda para las próximas facturas de este proveedor.
          </p>
        </div>
      )}

      {/* Ninguna orden del proveedor trae este articulo: eso si hay que
          arreglarlo antes de registrar. */}
      {sinCandidata.length > 0 && (
        <div className={styles.faltantes}>
          <p className={styles.faltantesTitulo}>
            {sinCandidata.length === 1
              ? 'Ninguna orden de compra de este proveedor tiene este artículo:'
              : 'Ninguna orden de compra de este proveedor tiene estos artículos:'}
          </p>
          {sinCandidata.map((r) => (
            <Fragment key={r.orden}>
            {/* La fila tiene SIEMPRE tres celdas --codigo, articulo,
                cantidad-- y nada mas. Lo que creciera adentro (los
                controles para vincular, el diagnostico, los talles) corria
                las columnas: hasta el 2026-10-08 el control de "cargo"
                metia una celda de mas en las filas CON codigo, y por eso el
                articulo caia en la columna de 90px --apilado en vertical--
                y la cantidad se iba a una linea aparte. Todo eso vive ahora
                en subfilas debajo. */}
            <div className={styles.faltanteFila}>
              {/* Un renglon SIN codigo no tiene nada que poner en esa
                  columna, y "(sin codigo)" era ruido: lo que el operador
                  mira es la descripcion, que pasa a ocupar las dos celdas
                  (2026-10-08, pedido del usuario). */}
              {r.codigo && (
                <span className={styles.codigo}>
                  {r.codigo}
                  {r.porDescripcion && (
                    <span className={styles.reconocidoNota} title="Resuelto por la descripción que enseñó el operador">
                      {' '}· por descripción
                    </span>
                  )}
                </span>
              )}
              <span className={r.codigo ? styles.desc : styles.descAncha}>
                {r.reconocidoComo ? (
                  <>
                    {/* El codigo solo se repite si es OTRO que el impreso:
                        cuando el renglon se resolvio por descripcion, el de
                        la izquierda YA es el de Tango y volver a escribirlo
                        es ruido. */}
                    {r.reconocidoComo.codArticu !== (r.codigo ?? '').trim() && (
                      <span className={styles.codigoNuestro}>→ {r.reconocidoComo.codArticu} · </span>
                    )}
                    {r.reconocidoComo.descripcion || '(sin descripción en el maestro)'}
                    {r.reconocidoComo.escala !== 'base' && (
                      <span className={styles.reconocidoNota}> · sin pendiente</span>
                    )}
                  </>
                ) : (
                  <span className={styles.descripcionFactura}>
                    {r.descripcion ?? '(sin descripción)'}
                  </span>
                )}
              </span>
              <span className={styles.cant}>{r.cantidad ?? '—'}</span>
            </div>

            {/* Un articulo BASE de escala no necesita otra orden: le falta
                el color o el talle. Va aparte porque es un diagnostico
                largo y poco frecuente, y en la fila desalineaba todo
                (2026-09-30, reportado por el usuario con DASS). */}
            {r.reconocidoComo?.escala === 'base' && (
              <p className={styles.faltanteNota}>
                {r.reconocidoComo.codArticu} es un artículo base: le falta el color o el talle
                {r.variantesEscala.length > 0 &&
                  ` · la orden tiene pendiente ${r.variantesEscala.map((v) => v.codArticu).join(', ')}`}
              </p>
            )}

            {/* Los controles para resolverlo. Debajo y no en la fila: son
                de alto variable --un desplegable, un buscador, un tilde--
                y meterlos en una celda rompia la grilla. */}
            {/* Un renglon DESGLOSADO no se vincula a un articulo: son
                varios. La linea de TOPPER "WAVE ... 380: 4 390: 6 400: 12
                415: 12 430: 8" son cinco articulos distintos, y el campo
                de codigo invitaba a mandarlos a uno solo -- paso, y quedo
                guardada la descripcion entera, WAVE incluido, apuntando a
                un unico articulo (2026-10-13, reportado por el usuario).
                Lo que corresponde ahi es imputar la orden, que es lo que
                reparte el renglon talle por talle. */}
            {puedeVincular && r.descripcion && r.equivalencias.length === 0 && (
              <div className={styles.faltanteAcciones}>
                {/* El codigo de Tango se ESCRIBE (2026-10-08, pedido del
                    usuario). Hasta ese dia habia un desplegable con los
                    articulos de las ORDENES pendientes, que para un
                    proveedor sin orden --justo el caso de los que no
                    imprimen codigo-- venia vacio y no resolvia nada. Si no
                    lo saben de memoria, el boton de al lado abre la
                    ventana, que busca en todo el maestro. */}
                <CampoCodigo
                  bloqueado={pendiente}
                  onResolver={(cod) => vincular(r.descripcion!, cod, comoCargo.has(r.orden))}
                />
                <button
                  type="button"
                  className={styles.buscarArticulo}
                  disabled={pendiente}
                  onClick={() => setBuscandoPara(`falta:${r.orden}`)}
                >
                  Buscar en Tango…
                </button>
                {buscandoPara === `falta:${r.orden}` && (
                  <BuscadorArticulos
                    codProvee={codProvee}
                    descripcionFactura={r.descripcion}
                    onElegir={(cod) => vincular(r.descripcion!, cod, comoCargo.has(r.orden))}
                    onCerrar={() => setBuscandoPara(null)}
                  />
                )}
                {/* Marcar un cargo SI cambia el comprobante --crea y borra
                    renglones--, asi que sigue atado a soloLectura. */}
                {!soloLectura && (
                  <label className={styles.cargoOpcion}>
                    <input
                      type="checkbox"
                      checked={comoCargo.has(r.orden)}
                      disabled={pendiente}
                      onChange={(e) =>
                        setComoCargo((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(r.orden)
                          else next.delete(r.orden)
                          return next
                        })
                      }
                    />
                    Es un cargo del proveedor: registrar sin orden de compra
                  </label>
                )}
              </div>
            )}
            {/* A que articulo de Tango corresponde cada talle del renglon.
                Se muestra aunque no haya ninguna orden con saldo: es el
                dato que faltaba para entender que "026459 001" es nuestro
                "26459  001 35" (2026-10-05, pedido del usuario). Es solo
                informacion -- lo que decide que se registra sigue siendo la
                orden imputada. */}
            {r.equivalencias.length > 0 && (
              <p className={styles.faltanteNota}>
                Son {r.equivalencias.length} artículos, uno por talle: se resuelven imputando la
                orden de compra, no vinculando el renglón a un artículo.
              </p>
            )}
            {r.equivalencias.map((e) => (
              <div key={e.codArticu} className={styles.equivalencia}>
                <span className={styles.codigo}>{e.codigoFactura}</span>
                <span className={styles.equivalenciaFlecha}>
                  → {e.codArticu}
                  {e.descripcion && ` · ${e.descripcion}`}
                </span>
                <span className={styles.cant}>{e.cantidad}</span>
              </div>
            ))}
            </Fragment>
          ))}
          <p className={styles.faltantesNota}>
            No se puede registrar hasta que todos los renglones tengan su orden.
            {sinCandidata.some((r) => r.reconocidoComo?.escala === 'base') &&
              ' Los artículos base no se facturan: en Tango el que se compra es la variante con el color o el talle' +
                ' pegado al código. Si la factura no lo trae, reprocesá el comprobante o elegí la variante acá abajo.'}
            {sinCandidata.some((r) => r.reconocidoComo && r.reconocidoComo.escala !== 'base') &&
              ' Los reconocidos necesitan una orden de compra con saldo en Tango: enseñar el código no lo resuelve.'}
            {sinCandidata.some((r) => !r.codigo) &&
              ' Los que vienen sin código se vinculan por su descripción, acá mismo: se guarda para este proveedor y la próxima factura empareja sola.'}
            {sinCandidata.some((r) => r.codigo && !r.reconocidoComo) &&
              ' Si es un artículo que la orden sí trae con otro nombre, asociá el código más abajo.'}
          </p>
        </div>
      )}

      {/* La orden existe y esta listada abajo: solo falta imputarla. No se
          dice cuando no hay ninguna imputada todavia, porque ahi ya lo dice
          el aviso de arriba y repetirlo lo haria parecer un error. */}
      {porImputar.length > 0 && imputadas.length > 0 && (
        <div className={styles.porImputar}>
          <p className={styles.faltantesTitulo}>
            {porImputar.length === 1
              ? 'Falta imputar la orden de este renglón:'
              : 'Falta imputar la orden de estos renglones:'}
          </p>
          {porImputar.map((r) => (
            <div key={r.orden} className={styles.faltanteFila}>
              <span className={styles.codigo}>
                {r.codigo || '(sin código)'}
                {r.porDescripcion && (
                  <span className={styles.reconocidoNota} title="Resuelto por la descripción que enseñó el operador">
                    {' '}· por descripción
                  </span>
                )}
              </span>
              {/* El codigo coincide con OTRA orden pendiente del proveedor,
                  pero puede no ser la orden correcta -- puede ser un cargo
                  (gestion de compra, logistica) que por casualidad comparte
                  articulo con algo que si se pidio. La app no tiene como
                  distinguirlo sola: lo dice el operador. */}
              {!soloLectura && r.codigo && r.descripcion ? (
                <button
                  type="button"
                  className={styles.quitar}
                  disabled={pendiente}
                  onClick={() => vincular(r.descripcion!, r.codigo, true)}
                >
                  Es un cargo del proveedor
                </button>
              ) : (
                <span />
              )}
              <span className={styles.cant}>{r.cantidad ?? '—'}</span>
            </div>
          ))}
        </div>
      )}

      {!codProvee && <p className={styles.vacio}>Primero hay que resolver el proveedor.</p>}
      {errorCarga && (
        <p className={styles.errorCarga}>No se pudieron buscar las órdenes de compra: {errorCarga}</p>
      )}

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
                    .filter((r) => oc.articulosQueCoinciden.includes(normalizarCodigo(r.codArticu)))
                    .map((r) => (
                      <div key={r.nRenglOc} className={styles.fila}>
                        <span className={styles.marca}>✓</span>
                        <span className={styles.codigo}>
                          {/* El codigo del proveedor primero: es el que el
                              operador ve impreso en el papel. */}
                          {oferta?.codigosFactura[normalizarCodigo(r.codArticu)] && (
                            <span className={styles.codigoFactura}>
                              {oferta.codigosFactura[normalizarCodigo(r.codArticu)]} →{' '}
                            </span>
                          )}
                          {r.codArticu}
                        </span>
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
