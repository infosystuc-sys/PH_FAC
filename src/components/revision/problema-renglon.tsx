'use client'

import { useState, useTransition } from 'react'
import {
  asociarCodigoProveedor,
  vincularDescripcionArticulo,
  marcarRenglonSinOc,
  buscarArticuloPorCodigo,
} from '@/server/app/acciones/articulos'
import { type OfertaOc } from '@/server/app/acciones/ordenesCompra'
import { useToast } from '@/components/toast/toast-provider'
import { BuscadorArticulos } from './buscador-articulos'
import styles from './problema-renglon.module.css'

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

/**
 * Lo que le pasa a UN renglón y cómo se arregla, debajo de la fila en la
 * tabla de renglones (2026-10-14, pedido del usuario). Hasta ese día era una
 * tarjeta aparte, "Para resolver en los renglones", que repetía lo que la
 * tabla ya decía en la columna del artículo de Tango. La columna dice QUÉ
 * pasa; esto dice qué se puede hacer, y no repite el diagnóstico.
 *
 * Devuelve `null` cuando el renglón no tiene nada que resolver: un renglón
 * con OC, o uno al que solo le falta elegirla en la columna de al lado.
 */
export function ProblemaRenglon({
  comprobanteId,
  codProvee,
  oferta,
  orden,
  onRecargar: cargar,
  soloLectura = false,
  permitirVincular = false,
}: {
  comprobanteId: number
  codProvee: string | null
  oferta: OfertaOc | null
  /** El ORDEN del renglón en el PDF. */
  orden: number
  /** Vuelve a pedir la oferta después de vincular o enseñar algo. */
  onRecargar: () => void
  soloLectura?: boolean
  /**
   * Deja enseñar una descripción aunque el resto esté de solo lectura. Ver
   * `puedeVincular`: lo que se guarda es del proveedor, no del comprobante.
   */
  permitirVincular?: boolean
}) {
  // El operador tildo "es un cargo" ANTES de elegir el articulo: se lee al
  // vincular, para que el vinculo se cree ya con SIN_OC=1 en el mismo paso.
  // Sin esto, tildar antes de elegir no tenia nada que actualizar --no
  // existe fila en PHF_ARTICULO_PROVEEDOR todavia-- y quedaba en un no-op.
  const [comoCargo, setComoCargo] = useState(false)
  const [buscando, setBuscando] = useState(false)
  const [pendiente, arrancar] = useTransition()
  const toast = useToast()

  // Vincular una descripcion con un articulo de Tango es conocimiento DEL
  // PROVEEDOR, no un cambio de este comprobante: se permite aunque el
  // comprobante este cerrado (2026-10-07, decision del usuario). Es lo
  // UNICO que se habilita: marcar un cargo si cambia el comprobante y sigue
  // atado a soloLectura. El server action ademas no toca sus renglones
  // cuando esta cerrado (ver comprobanteCerradoEn).
  const puedeVincular = !soloLectura || permitirVincular

  const asociar = (codSinoni: string, codArticu: string) =>
    arrancar(async () => {
      try {
        await asociarCodigoProveedor(comprobanteId, codProvee!, codArticu, codSinoni)
        toast(`"${codSinoni}" asociado a ${codArticu}`)
        cargar()
      } catch (e) {
        toast(e instanceof Error ? e.message : 'No se pudo asociar el código.')
      }
    })

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

  if (!oferta || !codProvee) return null

  // Un cargo del proveedor no es un problema, pero es el unico lugar donde
  // se lo puede cambiar o devolver a una orden.
  const cargo = oferta.cargos.find((c) => c.orden === orden)
  if (cargo) {
    return (
      <div className={`${styles.problema} ${styles.problemaInfo}`}>
        <span className={styles.problemaTexto}>
          Entra en la factura y en el asiento con el precio del comprobante, sin consumir pendiente de
          ninguna orden.
        </span>
        {!soloLectura && cargo.descripcion && (
          <>
            <button
              type="button"
              className={styles.buscarArticulo}
              disabled={pendiente}
              onClick={() => setBuscando(true)}
            >
              Cambiar artículo
            </button>
            {buscando && (
              <BuscadorArticulos
                codProvee={codProvee}
                descripcionFactura={cargo.descripcion}
                onElegir={(cod) => vincular(cargo.descripcion!, cod, true)}
                onCerrar={() => setBuscando(false)}
              />
            )}
            <button
              type="button"
              className={styles.quitar}
              disabled={pendiente}
              onClick={() => marcarCargo(cargo.descripcion!, false)}
            >
              Va contra una OC
            </button>
          </>
        )}
      </div>
    )
  }

  const r = oferta.sinOrden.find((x) => x.orden === orden)
  if (!r) return null

  // Hay una orden que lo tiene: falta elegirla en la columna OC, que ya se
  // marca en ambar. Lo unico que se ofrece es la salida de que no vaya
  // contra ninguna -- un cargo que por casualidad comparte articulo con
  // algo que si se pidio. Solo con alguna orden ya imputada, para no
  // ensuciar cada renglon de una factura recien abierta.
  if (r.hayCandidata) {
    if (soloLectura || oferta.imputadas.length === 0 || !r.codigo || !r.descripcion) return null
    return (
      <div className={`${styles.problema} ${styles.problemaInfo}`}>
        <span className={styles.problemaTexto}>Si no va contra ninguna orden:</span>
        <button
          type="button"
          className={styles.quitar}
          disabled={pendiente}
          onClick={() => vincular(r.descripcion!, r.codigo, true)}
        >
          Es un cargo del proveedor
        </button>
      </div>
    )
  }

  // Un renglon DESGLOSADO por talle son varios articulos: no se vincula a
  // uno solo. La linea de TOPPER "WAVE ... 380: 4 390: 6" son cinco
  // articulos, y el campo de codigo invitaba a mandarlos a uno solo -- paso
  // (2026-10-13). La equivalencia talle por talle ya la muestra la columna
  // de Tango; aca solo va que hacer.
  if (r.equivalencias.length > 0) {
    return (
      <div className={styles.problema}>
        <span className={styles.problemaTexto}>
          {r.equivalencias.length === 1
            ? 'Ninguna orden tiene pendiente este talle: se resuelve cargando la OC en Tango, no vinculando el renglón.'
            : 'Ninguna orden tiene pendientes estos talles: se resuelve cargando la OC en Tango, no vinculando el renglón.'}
        </span>
      </div>
    )
  }

  const reconocido = r.reconocidoComo
  // Reconocido y facturable: vincularlo de nuevo no cambia nada, lo que
  // falta es una orden con saldo (2026-10-14, DEPAOLO).
  if (reconocido && reconocido.escala !== 'base') {
    return (
      <div className={styles.problema}>
        <span className={styles.problemaTexto}>
          Cargá o ampliá la OC en Tango y volvé a abrir el comprobante.
        </span>
        {!soloLectura && r.descripcion && (
          <button
            type="button"
            className={styles.quitar}
            disabled={pendiente}
            onClick={() => vincular(r.descripcion!, reconocido.codArticu, true)}
          >
            Es un cargo: registrar sin OC
          </button>
        )}
      </div>
    )
  }

  // Lo que queda se arregla diciendole a que articulo corresponde: un
  // codigo que no se reconoce, un renglon sin codigo, o un articulo BASE
  // de escala al que le falta el color o el talle (2026-09-30, DASS).
  const sinonimo = !soloLectura && r.codigo !== '' && oferta.sinResolver.includes(r.codigo)
  const texto =
    reconocido?.escala === 'base'
      ? `${reconocido.codArticu} es un artículo base: le falta el color o el talle` +
        (r.variantesEscala.length > 0
          ? ` (la orden tiene pendiente ${r.variantesEscala.map((v) => v.codArticu).join(', ')}).`
          : '.') +
        ' Elegí la variante:'
      : r.codigo === ''
        ? 'Decí a qué artículo de Tango corresponde esta descripción; se recuerda para este proveedor:'
        : 'Decí a qué artículo de Tango corresponde; se recuerda para este proveedor:'

  if (!puedeVincular || !r.descripcion) {
    return (
      <div className={styles.problema}>
        <span className={styles.problemaTexto}>{texto.replace(/:$/, '.')}</span>
      </div>
    )
  }

  return (
    <div className={styles.problema}>
      <span className={styles.problemaTexto}>{texto}</span>
      {/* El codigo de Tango se ESCRIBE (2026-10-08, pedido del usuario): el
          operador casi siempre lo sabe. Si no, el boton de al lado busca en
          todo el maestro. */}
      <CampoCodigo
        bloqueado={pendiente}
        onResolver={(cod) => vincular(r.descripcion!, cod, comoCargo)}
      />
      <button
        type="button"
        className={styles.buscarArticulo}
        disabled={pendiente}
        onClick={() => setBuscando(true)}
      >
        Buscar en Tango…
      </button>
      {buscando && (
        <BuscadorArticulos
          codProvee={codProvee}
          descripcionFactura={r.descripcion}
          onElegir={(cod) => vincular(r.descripcion!, cod, comoCargo)}
          onCerrar={() => setBuscando(false)}
        />
      )}
      {/* El sinonimo se guarda en CPA15 y sirve tambien a Tango; solo se
          ofrece entre los articulos de las ordenes con pendiente. */}
      {sinonimo && oferta.articulosDisponibles.length > 0 && (
        <select
          className={styles.selectArticulo}
          defaultValue=""
          disabled={pendiente}
          onChange={(e) => e.target.value && asociar(r.codigo, e.target.value)}
          title="Guarda el código del proveedor como sinónimo en Tango"
        >
          <option value="">O elegí uno de las órdenes…</option>
          {oferta.articulosDisponibles.map((a) => (
            <option key={a.codArticu} value={a.codArticu}>
              {a.codArticu} · {a.descripcion}
            </option>
          ))}
        </select>
      )}
      {!soloLectura && (
        <label className={styles.cargoOpcion}>
          <input
            type="checkbox"
            checked={comoCargo}
            disabled={pendiente}
            onChange={(e) => setComoCargo(e.target.checked)}
          />
          Es un cargo: registrar sin OC
        </label>
      )}
    </div>
  )
}
