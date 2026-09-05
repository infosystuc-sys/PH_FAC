'use client'

import { resolverCodigoIva, CODIGO_IVA_PREFERIDO, type AlicuotaTango } from '@/lib/alicuotas'
import { JURISDICCIONES_IIBB, resolverIibbPorTipo, normalizar } from '@/lib/percepcionIibb'
import { codigosVarios } from '@/lib/percepciones'
import { parsearImporte } from '@/lib/formato'
import styles from './formulario.module.css'

type Tono = 'vacio' | 'ok' | 'alerta' | 'error'

function clasePorTono(tono: Tono): string {
  if (tono === 'ok') return styles.derivadoOk
  if (tono === 'alerta') return styles.derivadoAlerta
  if (tono === 'error') return styles.derivadoError
  return styles.derivadoVacio
}

/**
 * El código va primero porque la celda mide dos columnas (131px) y una
 * descripción como "PERCEPCION R.G.3337" no entra entera. Al recortarse se
 * pierde la cola, así que adelante tiene que ir el dato que se graba.
 */
function etiqueta(codigo: number | string, descripcion: string): string {
  return `${codigo} · ${descripcion}`
}

export type OpcionTango = { valor: string; label: string }

/**
 * La celda del medio de una fila de impuesto: a qué código de Tango va.
 *
 * Arranca mostrando lo que resolvió el sistema a partir de la columna de la
 * izquierda, y es una lista para que el operador lo corrija cuando la IA
 * leyó mal. Esa corrección se guarda aparte (codivaN / codpercepN) y gana
 * sobre lo resuelto; se limpia sola cuando cambia la columna izquierda, así
 * no queda un código viejo pegado a un dato que ya cambió.
 *
 * Va en Sans y no en Mono a propósito: la regla tipográfica del proyecto
 * reserva Mono para los datos que el operador cotejá contra el PDF, y esto
 * no está en el PDF -- es la clasificación que le pone Tango.
 */
function CeldaLista({
  opciones,
  valor,
  placeholder,
  tono,
  bloqueado,
  onCambio,
}: {
  opciones: OpcionTango[]
  /** El código elegido a mano, o el resuelto por el sistema. */
  valor: string
  /** Qué mostrar cuando no hay ninguno: "—", "No se registra", etc. */
  placeholder: string
  tono: Tono
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  return (
    <div className={styles.campo} style={{ gridColumn: 'span 2' }}>
      <span className={styles.label}>En Tango</span>
      <select
        className={`${styles.derivado} ${clasePorTono(tono)}`}
        value={valor}
        disabled={bloqueado}
        onChange={(e) => onCambio(e.target.value)}
      >
        <option value="">{placeholder}</option>
        {opciones.map((o) => (
          <option key={o.valor} value={o.valor}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Alícuota de IVA: la resuelve el PORCENTAJE, y el operador puede
 * corregirla.
 *
 * `importe` no se usa para resolver nada -- se usa para NO resolver. Esta
 * celda tiene que mostrar lo que se va a registrar, y `resolverAlicuotas`
 * descarta las líneas sin importe, así que una línea en cero no puede
 * mostrar un código ni marcarse en rojo. Pasa de verdad: hay comprobantes
 * que imprimen la tasa de una percepción con importe 0,00 (por ejemplo
 * "PERC IVA RG 2408 1,50% ... 0,00"), y esa línea salía en rojo como "Sin
 * código en Tango" pidiendo que el operador resolviera algo que no se iba
 * a grabar.
 */
export function CeldaAlicuotaTango({
  porcentaje,
  importe,
  correccion,
  alicuotas,
  aprendidos,
  bloqueado,
  onCambio,
}: {
  porcentaje: string
  importe: string
  correccion: string
  alicuotas: AlicuotaTango[]
  /** Lo que este proveedor ya enseñó para porcentajes que no resuelven solos. */
  aprendidos: Record<string, string>
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  const opciones = alicuotas.map((a) => ({
    valor: String(a.codigo),
    label: etiqueta(a.codigo, a.descripcion),
  }))

  const sinImporte = importe.trim() === '' || parsearImporte(importe) <= 0

  // Antes que todo lo demas, incluida la correccion manual: sin importe no
  // hay linea que grabar, y mostrar un codigo ahi seria mentir.
  if (sinImporte) {
    return (
      <CeldaLista
        opciones={opciones}
        valor=""
        placeholder="—"
        tono="vacio"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  if (correccion) {
    return (
      <CeldaLista
        opciones={opciones}
        valor={correccion}
        placeholder="—"
        tono="ok"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  const crudo = porcentaje.trim()
  const p = crudo === '' ? null : parsearImporte(crudo)

  // Sin porcentaje impreso (no es 0%, es que no hay dato): casi siempre una
  // percepcion de IVA sin tasa propia (ej. "Percepcion IVA RG 2408"), no una
  // alicuota real. Se resuelve directo al codigo preferido, mismo criterio
  // que el 3% ambiguo -- decision del usuario, 2026-08-21. Antes esto
  // mostraba "—" sin resolver nada, y la linea quedaba omitida del registro
  // salvo que el operador la corrigiera a mano cada vez.
  if (p === null) {
    const preferida = alicuotas.find((a) => a.codigo === CODIGO_IVA_PREFERIDO) ?? null
    return (
      <CeldaLista
        opciones={opciones}
        valor={preferida ? String(preferida.codigo) : ''}
        placeholder="—"
        tono={preferida ? 'ok' : 'vacio'}
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  // Norma de registración: la alícuota 0% no se graba. Se avisa acá mismo
  // para que el operador no descubra el faltante al registrar.
  if (p === 0) {
    return (
      <CeldaLista
        opciones={opciones}
        valor=""
        placeholder="No se registra"
        tono="alerta"
        bloqueado={bloqueado}
        onCambio={onCambio}
      />
    )
  }

  const encontrada = resolverCodigoIva(p, alicuotas, aprendidos)
  return (
    <CeldaLista
      opciones={opciones}
      valor={encontrada ? String(encontrada.codigo) : ''}
      placeholder="Sin código en Tango"
      tono={encontrada ? 'ok' : 'error'}
      bloqueado={bloqueado}
      onCambio={onCambio}
    />
  )
}

/**
 * Percepción de Ingresos Brutos: la resuelve la JURISDICCIÓN, nunca el
 * porcentaje -- el 60 (Tucumán) y el 61 (Salta) son ambos 2,5%.
 */
export function CeldaPercepcionTango({
  jurisdiccion,
  importe,
  correccion,
  tipoFactura,
  aprendidos,
  bloqueado,
  onCambio,
}: {
  jurisdiccion: string
  importe: string
  correccion: string
  /** En tarjeta el IIBB va al 64 aunque la jurisdiccion diga otra cosa. */
  tipoFactura: string
  /** Lo que este proveedor ya enseñó para jurisdicciones no reconocidas. */
  aprendidos: Record<string, string>
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  const opciones = JURISDICCIONES_IIBB.map((j) => ({
    valor: j.codigo,
    label: etiqueta(j.codigo, j.jurisdiccion),
  }))

  // Mismo criterio que en IVA: sin importe no hay nada que registrar (ver
  // resolverPercepciones, que tambien descarta esas lineas).
  const sinImporte = importe.trim() === '' || parsearImporte(importe) <= 0
  const vacio = sinImporte || (jurisdiccion.trim() === '' && !correccion)
  // El slot vacio no muestra codigo. Hace falta decirlo explicito desde que
  // en tarjeta la resolucion tiene un fallback al 64: sin esto, las cuatro
  // filas de percepcion arrancarian mostrando "64 · Bancarias" aunque no
  // haya ninguna linea, que se lee como si hubiera algo para registrar.
  const elegido = vacio
    ? ''
    : correccion || resolverIibbPorTipo(jurisdiccion, tipoFactura, aprendidos)?.codigo || ''

  return (
    <CeldaLista
      opciones={opciones}
      valor={elegido}
      placeholder={vacio ? '—' : 'Jurisdicción no reconocida'}
      tono={elegido ? 'ok' : vacio ? 'vacio' : 'error'}
      bloqueado={bloqueado}
      onCambio={onCambio}
    />
  )
}

/**
 * Impuestos varios: el código ya se elige en la columna de la izquierda,
 * así que acá no hay nada que corregir -- solo se confirma qué es en Tango.
 */
export function CeldaVariosTango({
  texto,
  importe,
  correccion,
  codigos,
  aprendidos,
  bloqueado,
  onCambio,
}: {
  /** El rótulo impreso del impuesto, que es la clave de lo aprendido. */
  texto: string
  importe: string
  correccion: string
  codigos: { codigo: number; descripcion: string }[]
  /** Lo que este proveedor ya enseñó para estos rótulos. */
  aprendidos: Record<string, string>
  bloqueado: boolean
  onCambio: (v: string) => void
}) {
  const opciones = codigosVarios(codigos).map((c) => ({
    valor: String(c.codigo),
    label: etiqueta(c.codigo, c.descripcion),
  }))

  // Mismo criterio que IVA y percepciones: sin importe no hay linea que
  // registrar, y resolverVarios tambien la descarta.
  const sinImporte = importe.trim() === '' || parsearImporte(importe) <= 0
  const rotulo = texto.trim()
  const vacio = sinImporte || (rotulo === '' && !correccion)

  // Compatibilidad con los comprobantes anteriores al cambio, que tienen el
  // codigo guardado en el campo del rotulo -- mismo criterio que
  // resolverVarios, para que la celda muestre lo mismo que se va a registrar.
  const codigoLegado =
    /^\d+$/.test(rotulo) && opciones.some((o) => o.valor === rotulo) ? rotulo : ''

  const elegido = vacio ? '' : correccion || codigoLegado || aprendidos[normalizar(rotulo)] || ''

  return (
    <CeldaLista
      opciones={opciones}
      valor={elegido}
      placeholder={vacio ? '—' : 'Elegí el impuesto'}
      tono={elegido ? 'ok' : vacio ? 'vacio' : 'error'}
      bloqueado={bloqueado}
      onCambio={onCambio}
    />
  )
}

/**
 * El concepto de Tango contra el que se imputa el comprobante. No es un
 * campo: no sale del PDF ni de una eleccion del operador. En una factura de
 * conceptos sale de la ficha del proveedor, y en una liquidacion de tarjeta
 * es el fijo de comisiones -- ver conceptoDelComprobante.
 *
 * En una factura de articulos no hay concepto: se imputa renglon por
 * renglon contra el remito, asi que no hay ficha que consultar. Antes esa
 * celda mostraba en rojo "El proveedor no tiene concepto en Tango", que era
 * falso dos veces: no falta nada y no hace falta buscarlo.
 */
export function CeldaConcepto({
  concepto,
  hayProveedor,
  tipoFactura,
}: {
  concepto: { codConcepto: string; descripcion: string } | null
  hayProveedor: boolean
  tipoFactura: string
}) {
  // Los articulos no llevan concepto: es informativo, no un faltante.
  if (tipoFactura === 'articulos') {
    return (
      <div className={styles.campo} style={{ gridColumn: 'span 3' }}>
        <span className={styles.label}>Concepto en Tango</span>
        <div className={`${styles.derivado} ${clasePorTono('vacio')}`}>
          No aplica para facturas de artículos
        </div>
      </div>
    )
  }

  const texto = concepto
    ? etiqueta(concepto.codConcepto, concepto.descripcion)
    : hayProveedor
      ? 'El proveedor no tiene concepto en Tango'
      : '—'
  const tono: Tono = concepto ? 'ok' : hayProveedor ? 'error' : 'vacio'

  return (
    <div className={styles.campo} style={{ gridColumn: 'span 3' }}>
      <span className={styles.label}>Concepto en Tango</span>
      <div className={`${styles.derivado} ${clasePorTono(tono)}`} title={texto}>
        {texto}
      </div>
    </div>
  )
}
