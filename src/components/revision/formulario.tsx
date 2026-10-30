'use client'

import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  GRUPOS,
  camposDelGrupo,
  OCULTOS_EN_GRILLA,
  clavesDeImpuestosVacios,
  type GrupoCampo,
  type DefCampo,
} from '@/lib/campos'
import { guardarCampo, aprenderImpuestoTango } from '@/server/app/acciones'
import { totalImputado, formatMoneda } from '@/lib/formato'
import { TIPOS_FACTURA, analizaCampo, spanDe, tipoFacturaODefault } from '@/lib/tipoFactura'
import type { AlicuotaTango } from '@/lib/alicuotas'
import { codigosVarios } from '@/lib/percepciones'
import {
  CeldaAlicuotaTango,
  CeldaPercepcionTango,
  CeldaVariosTango,
  CeldaConcepto,
} from './alicuota-tango'
import type { CondicionCompra } from '@/server/tango/condicionesCompra'
import type { CodigoImpuesto } from '@/server/tango/impuestos'
import { Campo } from './campo'
import styles from './formulario.module.css'

export type ValorInicial = { valor: string; confianza: number | null }

const MAX_SLOTS_ALICUOTA = 5

/**
 * La cabecera en UNA tarjeta compacta (2026-10-27, pedido del usuario con
 * una captura): comprobante, proveedor e imputación en Tango, en filas, con
 * cada campo del ancho de lo que lleva -- "A" no necesita el mismo lugar que
 * una razón social. Antes eran tres tarjetas en una grilla de 6 columnas,
 * con mucho aire y los datos lejos unos de otros.
 *
 * Cada fila junta los campos de esas claves que estén visibles en este tipo
 * de comprobante (ver camposVisibles): si un tipo agrega CAE o remitos, se
 * suman a su fila y la fila se acomoda sola. `null` es la celda del
 * concepto, que pinta el formulario y no el catálogo.
 */
const FILAS_CABECERA: (string | null)[][] = [
  ['tipo', 'ptovta', 'nro', 'fecha', 'fechacontable', 'cae', 'vtocae', 'moneda', 'cotizacion',
    'ordencompra', 'remito1', 'remito2', 'condpago'],
  ['razon', 'condiva', 'vencimiento', 'codprovee', 'cuit'],
  ['condcompra', 'tipoFactura', null],
  ['leyendaAsiento'],
]

/** Ancho de cada campo en la tarjeta compacta: fijo, o 'flex' para el que
 *  se estira y ocupa lo que sobra de la fila. */
const ANCHO_CABECERA: Record<string, number | 'flex'> = {
  tipo: 48,
  ptovta: 92,
  nro: 104,
  fecha: 116,
  fechacontable: 116,
  cae: 150,
  vtocae: 116,
  moneda: 72,
  cotizacion: 96,
  ordencompra: 140,
  remito1: 150,
  remito2: 150,
  condpago: 'flex',
  razon: 'flex',
  condiva: 150,
  vencimiento: 116,
  codprovee: 120,
  cuit: 132,
  condcompra: 200,
  tipoFactura: 190,
  concepto: 'flex',
  leyendaAsiento: 'flex',
}

function estiloCabecera(clave: string): React.CSSProperties {
  const ancho = ANCHO_CABECERA[clave] ?? 140
  return ancho === 'flex' ? { flex: '1 1 200px', minWidth: 0 } : { flex: `0 0 ${ancho}px`, minWidth: 0 }
}

/**
 * Sobre 15.625 facturas reales: el slot 2 de alícuota se usa en el 19% de
 * los casos, el 3 en el 3,3%, el 4 en el 0,4%, y el 5 nunca. Mostrar los
 * cinco slots siempre seria ruido permanente en la pantalla donde el
 * operador pasa el 90% del tiempo, con 20 a 100 comprobantes por día.
 *
 * Punto de partida: los que la IA encontró con valor, más uno vacío para
 * poder agregar uno nuevo. De acá en más el piso de `slots` (ver `cambiar`
 * más abajo) solo crece -- nunca se recalcula desde cero ni se achica --
 * para que completar el slot vacío revele uno nuevo (la mitad del
 * comportamiento que hacía falta) sin reacomodar nada si el operador
 * borra un slot intermedio mientras escribe (la otra mitad).
 */
function contarSlotsAlicuota(iniciales: Record<string, ValorInicial>): number {
  let ultimoConValor = 0
  for (let i = 1; i <= MAX_SLOTS_ALICUOTA; i++) {
    const tienePorcentaje = (iniciales[`porciva${i}`]?.valor ?? '').trim() !== ''
    const tieneImporte = (iniciales[`impiva${i}`]?.valor ?? '').trim() !== ''
    if (tienePorcentaje || tieneImporte) ultimoConValor = i
  }
  return Math.min(MAX_SLOTS_ALICUOTA, ultimoConValor + 1)
}

const RE_SLOT_ALICUOTA = /^(?:porciva|impiva)([1-5])$/
/** Las celdas que disparan la resolución contra Tango, una por familia. */
const RE_PORC_ALICUOTA = /^porciva([1-5])$/
const RE_PERCEP = /^percep([1-4])$/
const RE_VARIOS = /^varios([12])$/
/** La corrección a mano de cada familia -- si el operador la completa,
 *  eso es lo que se aprende para el proveedor. */
const RE_CORRECCION_IVA = /^codiva([1-5])$/
const RE_CORRECCION_PERCEP = /^codpercep([1-4])$/
const RE_CORRECCION_VARIOS = /^codvarios([12])$/

type Opcion = { valor: string; label: string }

function opcionesPara(
  clave: string,
  condicionesCompra: CondicionCompra[],
  codigosImpuesto: CodigoImpuesto[],
): Opcion[] | undefined {
  if (clave === 'condcompra') {
    return condicionesCompra.map((c) => ({ valor: String(c.codigo), label: c.descripcion }))
  }
  if (/^varios[12]$/.test(clave)) {
    // Todo lo de CPA14 que no es alicuota de IVA ni percepcion de IIBB:
    // impuesto interno, ganancias, retenciones municipales y demas.
    return codigosVarios(codigosImpuesto).map((c) => ({
      valor: String(c.codigo),
      label: c.descripcion,
    }))
  }
  if (clave === 'tipoFactura') {
    // Mismo catalogo que el modal de importacion: el operador ya lo eligio
    // ahi, esto le deja reclasificar el comprobante si se equivoco. La
    // liquidacion de tarjeta figura aunque todavia no tenga logica de
    // registro propia -- validarTipoFactura bloquea el registro, pero
    // clasificar tiene que poder clasificarse igual.
    return TIPOS_FACTURA.map((t) => ({ valor: t.clave, label: t.label }))
  }
  return undefined
}

function camposVisibles(
  grupo: GrupoCampo,
  slots: number,
  valores: Record<string, string>,
  ocultarVacios: boolean,
): DefCampo[] {
  const tipo = tipoFacturaODefault(valores.tipoFactura)

  // Los campos que la IA no analiza en este tipo tampoco se muestran: son
  // ocho casilleros que quedarian siempre vacios en la pantalla donde el
  // operador pasa el dia. La excepcion es que ya tengan valor -- un
  // comprobante leido con un prompt anterior, o un dato cargado a mano --
  // porque esconder un dato que existe es peor que mostrar uno de mas.
  // Y el ancho puede cambiar con el tipo: sacar campos de un grupo
  // descuadra la grilla de 6 columnas, asi que los que quedan se
  // reacomodan para volver a llenar filas enteras. Ver spanDe.
  const todos = camposDelGrupo(grupo)
    .filter(
      (def) =>
        // Los que el operador también escribe se muestran igual: esconderlos
        // porque la IA no los lee en este tipo lo dejaría sin dónde tipearlos.
        def.siempreVisible ||
        analizaCampo(tipo, def.clave) ||
        (valores[def.clave] ?? '').trim() !== '',
    )
    .map((def) => {
      const span = spanDe(tipo, def.clave, def.span)
      return span === def.span ? def : { ...def, span }
    })

  // Los codigos corregidos a mano (y el concepto elegido) los pinta la
  // celda de al lado de su campo, no este bucle -- ver OCULTOS_EN_GRILLA en
  // campos.ts.
  const visibles = todos.filter((def) => !OCULTOS_EN_GRILLA.test(def.clave))
  if (grupo !== 'importes') return visibles

  // Los casilleros de impuesto que estan enteramente vacios, cuando el
  // operador pidio esconderlos (2026-10-08). Un comprobante usa dos o tres
  // de los once, asi que el grupo mostraba una veintena de casillas vacias.
  const vacias = ocultarVacios ? clavesDeImpuestosVacios(valores) : null

  return visibles.filter((def) => {
    if (vacias?.has(def.clave)) return false
    const m = RE_SLOT_ALICUOTA.exec(def.clave)
    return !m || Number(m[1]) <= slots
  })
}

export function Formulario({
  comprobanteId,
  iniciales,
  onEnfocar,
  soloLectura = false,
  ocultarVacios = false,
  permitirAprender = false,
  condicionesCompra,
  codigosImpuesto,
  alicuotasIva,
  concepto,
  conceptos,
  aprendidosIva,
  aprendidosPercepcion,
  aprendidosVarios,
}: {
  comprobanteId: number
  iniciales: Record<string, ValorInicial>
  onEnfocar: (texto: string | null) => void
  /**
   * Esconde los casilleros de impuestos, alicuotas y percepciones que no
   * tienen ningun valor. Lo decide el operador con un tilde de la barra de
   * vista; se guarda en localStorage y vale para todos los comprobantes.
   */
  ocultarVacios?: boolean
  /**
   * Deja corregir a qué impuesto de Tango va una alícuota, una percepción
   * o una condición de compra aunque el comprobante esté cerrado
   * (2026-10-10, decisión del usuario; mismo criterio que `permitirVincular`
   * en el selector de OC).
   *
   * Lo que se guarda en ese caso es SOLO la equivalencia del PROVEEDOR,
   * que vale para las facturas que vengan. El comprobante registrado no se
   * toca: ya está en Tango y corregirle un campo acá no lo cambiaría allá.
   * Sin esto, una equivalencia mal aprendida se repetía en cada factura y
   * no había dónde arreglarla.
   */
  permitirAprender?: boolean
  // El comprobante está en estado `registrado`: terminal e inmutable
  // (mismo criterio que ya aplica BarraAcciones deshabilitando el botón
  // primario con title="Ver asiento en Tango"). El backend ya bloquea la
  // escritura en guardarCampoEn (src/server/app/detalle.ts) con un no-op
  // silencioso; esto es puramente para que la UI no mienta mostrando el
  // campo como editable.
  soloLectura?: boolean
  // Poblado real de Tango para los campos `tipo: 'select'` del catálogo.
  // Ver Campo -- el resto de los campos los ignora.
  condicionesCompra: CondicionCompra[]
  codigosImpuesto: CodigoImpuesto[]
  // Las alícuotas de IVA de CPA14, para resolver en vivo a cuál va cada
  // porcentaje leído del PDF (ver CeldaAlicuotaTango).
  alicuotasIva: AlicuotaTango[]
  // El concepto de Tango del proveedor ya resuelto. Se resuelve en el
  // servidor porque depende de codprovee, que cambia con router.refresh
  // cuando el operador elige otro proveedor.
  concepto: { codConcepto: string; descripcion: string } | null
  // El maestro de conceptos (CPA45), para que el operador pueda elegir otro
  // para este comprobante sin tocar la ficha del proveedor.
  conceptos: { codConcepto: string; descripcion: string }[]
  // Lo que este proveedor ya le enseñó a la app para IVA e IIBB, para que
  // las celdas "En Tango" propongan en vivo el mismo código que va a
  // resolver el registro real. Ver aprendizajeImpuestos.ts.
  aprendidosIva: Record<string, string>
  aprendidosPercepcion: Record<string, string>
  aprendidosVarios: Record<string, string>
}) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(iniciales).map(([k, v]) => [k, v.valor])),
  )
  const [slots, setSlots] = useState(() => contarSlotsAlicuota(iniciales))

  const imputado = useMemo(() => formatMoneda(totalImputado(valores)), [valores])

  const limpiarCorreccion = useCallback(
    (clave: string) => {
      setValores((prev) => {
        if (!prev[clave]) return prev
        if (!soloLectura) void guardarCampo(comprobanteId, clave, '')
        return { ...prev, [clave]: '' }
      })
    },
    [comprobanteId, soloLectura],
  )

  // Los desplegables de "En Tango" se habilitan aunque el comprobante este
  // cerrado: lo que guardan es la equivalencia DEL PROVEEDOR, no un dato de
  // este comprobante (ver permitirAprender). Los campos de datos --importes,
  // fechas, numero-- siguen bloqueados: esos si son del comprobante.
  const bloquearEquivalencia = soloLectura && !permitirAprender

  const cambiar = useCallback(
    (clave: string, v: string) => {
      setValores((prev) => (prev[clave] === v ? prev : { ...prev, [clave]: v }))

      // Si lo que se completó es un slot de alícuota y quedó con valor,
      // el piso de slots visibles crece para revelar el próximo vacío --
      // Math.max así nunca lo achica si en cambio se está borrando.
      const m = RE_SLOT_ALICUOTA.exec(clave)
      if (m && v.trim() !== '') {
        const siguiente = Math.min(MAX_SLOTS_ALICUOTA, Number(m[1]) + 1)
        setSlots((prev) => Math.max(prev, siguiente))
      }

      // Si cambio el dato del que se deriva el codigo, la correccion manual
      // que hubiera quedado ya no corresponde a este dato: se limpia para
      // que vuelva a mandar lo que resuelve el sistema. Un codigo viejo
      // pegado a un porcentaje nuevo es el error mas silencioso de los dos.
      const iva = RE_PORC_ALICUOTA.exec(clave)
      if (iva) limpiarCorreccion(`codiva${iva[1]}`)
      const perc = RE_PERCEP.exec(clave)
      if (perc) limpiarCorreccion(`codpercep${perc[1]}`)
      const varios = RE_VARIOS.exec(clave)
      if (varios) limpiarCorreccion(`codvarios${varios[1]}`)

      // El operador corrigió a qué código de Tango va un porcentaje o una
      // jurisdicción que no se resolvió solo: se aprende para este
      // proveedor, así la próxima factura con el mismo texto ya no va a
      // necesitar la corrección de nuevo.
      const codProvee = (valores.codprovee ?? '').trim()
      if (codProvee && v.trim() !== '') {
        const correccionIva = RE_CORRECCION_IVA.exec(clave)
        if (correccionIva) {
          const porcentaje = (valores[`porciva${correccionIva[1]}`] ?? '').trim()
          if (porcentaje) void aprenderImpuestoTango(comprobanteId, codProvee, 'iva', porcentaje, v.trim())
        }
        const correccionPercep = RE_CORRECCION_PERCEP.exec(clave)
        if (correccionPercep) {
          const jurisdiccion = (valores[`percep${correccionPercep[1]}`] ?? '').trim()
          if (jurisdiccion) {
            void aprenderImpuestoTango(comprobanteId, codProvee, 'percepcion', jurisdiccion, v.trim())
          }
        }

        // El operador eligió a qué impuesto de Tango va un "varios". Se
        // aprende contra el rótulo impreso, igual que la jurisdicción de
        // IIBB. Hasta 2026-09-04 esto no existía y la elección se perdía en
        // cada comprobante: lo reportó el usuario con dos liquidaciones
        // seguidas de Tarjeta Naranja.
        const correccionVarios = RE_CORRECCION_VARIOS.exec(clave)
        if (correccionVarios) {
          const rotulo = (valores[`varios${correccionVarios[1]}`] ?? '').trim()
          // Un rótulo que es solo dígitos viene de un comprobante viejo, que
          // guardaba el código ahí: aprenderlo enseñaría "56 -> 56".
          if (rotulo && !/^\d+$/.test(rotulo)) {
            void aprenderImpuestoTango(comprobanteId, codProvee, 'varios', rotulo, v.trim())
          }
        }

        // El operador eligió a mano la condición de compra: si esta
        // factura trae el texto de condición de pago/venta que imprimió
        // el proveedor, se aprende la relación -- misma idea que IVA/IIBB,
        // para que la próxima factura de artículos de este proveedor con
        // el mismo texto ya no necesite elegirla de nuevo (ver
        // resolverCondicionCompraEn en cola.ts).
        if (clave === 'condcompra') {
          const condicionTexto = (valores.condpago ?? '').trim()
          if (condicionTexto) {
            void aprenderImpuestoTango(comprobanteId, codProvee, 'condicion', condicionTexto, v.trim())
          }
        }

      }

      // Un comprobante cerrado no se modifica: lo de arriba --la
      // equivalencia del proveedor-- vale para las facturas que vengan,
      // pero este comprobante ya esta en Tango. El backend igual lo
      // bloquea con un no-op silencioso (ver guardarCampoEn); no llamarlo
      // deja claro de este lado que no se intenta.
      if (!soloLectura) void guardarCampo(comprobanteId, clave, v)
    },
    [comprobanteId, limpiarCorreccion, valores, soloLectura],
  )

  // Las celdas de un campo: el input, y en las tres familias de impuestos
  // la celda derivada de al lado. La usan las dos tarjetas.
  const celdas = (def: DefCampo, estilo?: React.CSSProperties, compacta = false) => {
    // "Total imputado" no es un input: se recalcula en vivo a
    // partir de los demas campos del grupo. Un <input readOnly>
    // generico no serviria: Campo guarda su valor en estado
    // local para el autosave y ese estado no se resincroniza
    // con la prop despues del primer render, asi que nunca
    // reflejaria los cambios en neto/impivaN mientras se edita.
    if (def.clave === 'imputado') {
      return [
        <div
          key={def.clave}
          className={styles.campo}
          style={estilo ?? { gridColumn: `span ${def.span}` }}
        >
          <span className={styles.label}>{def.label}</span>
          <div className={styles.valorCalculado}>{imputado}</div>
        </div>,
      ]
    }

    const campo = (
      <Campo
        key={def.clave}
        def={def}
        valor={valores[def.clave] ?? ''}
        confianza={iniciales[def.clave]?.confianza ?? null}
        bloqueado={soloLectura}
        opciones={opcionesPara(def.clave, condicionesCompra, codigosImpuesto)}
        onCambio={(v) => cambiar(def.clave, v)}
        onFoco={onEnfocar}
        onDesenfoque={() => onEnfocar(null)}
        estilo={estilo}
        sinChip={compacta}
      />
    )

    // Las tres familias de linea del grupo "Importes" se
    // muestran igual: tres celdas de span 2, con la del medio
    // diciendo a que codigo de Tango resuelve la de la
    // izquierda. Esa celda la arma el formulario porque es
    // derivada y no se guarda -- ver el comentario del grupo
    // en src/lib/campos.ts. Lo que cambia entre familias es
    // que identifica cada una: porcentaje, jurisdiccion o
    // codigo elegido a mano.

    const slotIva = RE_PORC_ALICUOTA.exec(def.clave)
    if (slotIva) {
      const correccion = `codiva${slotIva[1]}`
      return [
        campo,
        <CeldaAlicuotaTango
          key={`tango-${def.clave}`}
          porcentaje={valores[def.clave] ?? ''}
          importe={valores[`impiva${slotIva[1]}`] ?? ''}
          correccion={valores[correccion] ?? ''}
          alicuotas={alicuotasIva}
          aprendidos={aprendidosIva}
          bloqueado={bloquearEquivalencia}
          onCambio={(v) => cambiar(correccion, v)}
        />,
      ]
    }

    const slotPercep = RE_PERCEP.exec(def.clave)
    if (slotPercep) {
      const correccion = `codpercep${slotPercep[1]}`
      return [
        campo,
        <CeldaPercepcionTango
          key={`tango-${def.clave}`}
          jurisdiccion={valores[def.clave] ?? ''}
          importe={valores[`imppercep${slotPercep[1]}`] ?? ''}
          correccion={valores[correccion] ?? ''}
          tipoFactura={valores.tipoFactura ?? ''}
          codigos={codigosImpuesto}
          aprendidos={aprendidosPercepcion}
          bloqueado={bloquearEquivalencia}
          onCambio={(v) => cambiar(correccion, v)}
        />,
      ]
    }

    const slotVarios = RE_VARIOS.exec(def.clave)
    if (slotVarios) {
      const correccion = `codvarios${slotVarios[1]}`
      return [
        campo,
        <CeldaVariosTango
          key={`tango-${def.clave}`}
          texto={valores[def.clave] ?? ''}
          importe={valores[`impvarios${slotVarios[1]}`] ?? ''}
          correccion={valores[correccion] ?? ''}
          codigos={codigosImpuesto}
          aprendidos={aprendidosVarios}
          bloqueado={bloquearEquivalencia}
          onCambio={(v) => cambiar(correccion, v)}
        />,
      ]
    }

    return [campo]
  }

  const celdaConcepto = (estilo: React.CSSProperties) => (
    <CeldaConcepto
      key="concepto"
      concepto={concepto}
      conceptos={conceptos}
      eleccion={valores.concepto ?? ''}
      hayProveedor={(valores.codprovee ?? '').trim() !== ''}
      tipoFactura={valores.tipoFactura ?? ''}
      bloqueado={soloLectura}
      onCambio={(v) => cambiar('concepto', v)}
      estilo={estilo}
    />
  )

  // Los campos visibles de la cabecera, ordenados en sus filas. Una fila sin
  // ningun campo visible no se pinta.
  const visiblesCabecera = new Map(
    (['comprobante', 'proveedor', 'imputacion'] as GrupoCampo[])
      .flatMap((g) => camposVisibles(g, slots, valores, ocultarVacios))
      .map((d) => [d.clave, d] as const),
  )
  const cabecera = FILAS_CABECERA.map((fila) =>
    fila.flatMap((clave) => {
      if (clave === null) return [null]
      const def = visiblesCabecera.get(clave)
      return def ? [def] : []
    }),
  ).filter((fila) => fila.some((d) => d !== null))
  const importes = camposVisibles('importes', slots, valores, ocultarVacios)

  return (
    <div className={styles.panel}>
      <div className={styles.contenido}>
        {/* Sin esto la pantalla mentiria: el operador cambia el
            desplegable, ve el cambio, recarga y vuelve el valor viejo
            --porque el comprobante no se toca-- y no entiende por que. */}
        {soloLectura && permitirAprender && (
          <p className={styles.avisoAprender}>
            Este comprobante ya está cerrado y no se modifica. Lo que cambies en
            &quot;En Tango&quot; se guarda como la equivalencia de este proveedor y se aplica a
            las facturas que vengan.
          </p>
        )}
        {cabecera.length > 0 && (
          <section className={styles.tarjeta}>
            <h3 className={styles.tituloGrupo}>Comprobante</h3>
            <div className={styles.cabecera}>
              {cabecera.map((fila, i) => (
                <div key={i} className={styles.filaCabecera}>
                  {fila.flatMap((def) =>
                    def === null
                      ? [celdaConcepto(estiloCabecera('concepto'))]
                      : celdas(def, estiloCabecera(def.clave), true),
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
        {importes.length > 0 && (
          <section className={styles.tarjeta}>
            <h3 className={styles.tituloGrupo}>Importes</h3>
            <div className={styles.grilla}>{importes.flatMap((def) => celdas(def))}</div>
          </section>
        )}
      </div>
    </div>
  )
}
