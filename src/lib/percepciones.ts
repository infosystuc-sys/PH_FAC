import { parsearImporte } from './formato'
import {
  JURISDICCIONES_IIBB,
  resolverIibbPorTipo,
  normalizar,
  type CodigoIibb,
} from './percepcionIibb'

export const MAX_SLOTS_PERCEPCION = 4
export const MAX_SLOTS_VARIOS = 2

/**
 * El codigo de "Impuestos varios" al que va el SIRTAC de un resumen de
 * tarjeta: el 67, "RET SIRTAC".
 *
 * Hay tres codigos candidatos en CPA14 -- el 56 ("RETENCION MUNICIPAL"),
 * el 63 ("RET IIBB TUCUMAN") y el 67 ("RET SIRTAC") -- y este dio tres
 * vueltas antes de quedar en el que lleva el nombre:
 *
 *   2026-08-17  el 56, con el 56 y el 67 a la vista
 *   2026-09-05  el 63 -- "el impuesto correcto es Ingresos Brutos Tucuman"
 *   2026-09-06  el 67, corrigiendo lo anterior ("error mio")
 *
 * Las tres son decisiones explicitas del usuario. Queda escrito el
 * recorrido porque el argumento del 63 --que el SIRTAC es un regimen de
 * recaudacion de Ingresos Brutos-- sigue siendo cierto y podria tentar a
 * "corregirlo" una cuarta vez: la imputacion elegida es la cuenta propia
 * del regimen, no la de IIBB Tucuman. Cambiarlo mueve la imputacion
 * contable de todos los resumenes de tarjeta.
 */
export const COD_VARIOS_SIRTAC = '67'

/** Un código de CPA14 tal como lo devuelve `listarCodigosImpuesto`. */
export type CodigoTango = { codigo: number; descripcion: string }

export type EstadoLinea = 'registra' | 'sin-codigo'

export type LineaPercepcion = {
  slot: number
  /** La jurisdicción tal como la leyó la IA del comprobante. */
  texto: string
  importe: number
  estado: EstadoLinea
  codigo: CodigoIibb | null
}

export type LineaVarios = {
  slot: number
  /** El código de Tango resuelto: corregido, aprendido o legado. */
  codigo: string
  /** El rótulo impreso del impuesto, que es la clave de lo aprendido. */
  texto: string
  importe: number
  estado: EstadoLinea
  descripcion: string | null
}

/**
 * Los códigos que la app admite en "Impuestos varios": todo lo que en
 * CPA14 no es alícuota de IVA y tampoco es una de las cinco percepciones
 * de Ingresos Brutos. Se deriva de lo que devuelve Tango en vez de
 * repetir la lista acá, así una alta o baja en CPA14 no deja el catálogo
 * de la app desincronizado en silencio.
 */
export function codigosVarios<T extends { codigo: number }>(codigosImpuesto: T[]): T[] {
  return codigosImpuesto.filter(
    (c) => !JURISDICCIONES_IIBB.some((j) => j.codigo === String(c.codigo)),
  )
}

/**
 * Resuelve los cuatro slots de percepción contra las jurisdicciones
 * admitidas. Igual que con las alícuotas de IVA, la usan los dos lados --
 * el panel de la revisión y el armado de CPA18 -- para que no puedan
 * discrepar.
 *
 * Solo entran los slots con importe > 0: una jurisdicción sin importe no
 * genera línea, no hay nada que grabar.
 */
export function resolverPercepciones(
  valores: Record<string, string | null | undefined>,
  tipoFactura?: string | null,
  aprendidos?: Record<string, string>,
): LineaPercepcion[] {
  const lineas: LineaPercepcion[] = []

  for (let slot = 1; slot <= MAX_SLOTS_PERCEPCION; slot++) {
    const importe = parsearImporte(valores[`imppercep${slot}`])
    if (importe <= 0) continue

    const texto = (valores[`percep${slot}`] ?? '').trim()
    // Igual que en las alicuotas: el codigo corregido a mano gana sobre la
    // jurisdiccion leida, que es para lo que existe.
    const correccion = (valores[`codpercep${slot}`] ?? '').trim()
    const codigo = correccion
      ? (JURISDICCIONES_IIBB.find((j) => j.codigo === correccion) ?? null)
      : resolverIibbPorTipo(texto, tipoFactura ?? valores.tipoFactura, aprendidos)
    lineas.push({
      slot,
      texto,
      importe,
      estado: codigo ? 'registra' : 'sin-codigo',
      codigo,
    })
  }

  return lineas
}

/**
 * A qué código de Tango va UNA línea de impuestos varios.
 *
 * Existe como función aparte porque la usan los dos lados -- `resolverVarios`,
 * que arma CPA18, y la celda "En Tango" del formulario -- y hasta el
 * 2026-09-06 la celda repetía esta precedencia a mano y se le había quedado
 * afuera el último término, el del SIRTAC. El efecto era que en una
 * liquidación que nadie hubiera corregido todavía el desplegable aparecía
 * vacío y en rojo mientras el registro imputaba bien al 67: la pantalla
 * decía una cosa y Tango recibía otra. Lo reportó el usuario con las
 * liquidaciones de Galicia, BBVA y Credicoop -- en las de Banco Macro no se
 * veía, porque ahí ya había una corrección guardada que tapaba el hueco.
 *
 * El orden es el mismo que en IVA e IIBB: lo que el operador corrigió en
 * este comprobante gana sobre lo aprendido del proveedor, y lo aprendido
 * gana sobre la regla general del SIRTAC -- una corrección para ese
 * proveedor es más específica que una regla para todos.
 *
 * Devuelve '' si no resuelve a nada, que es lo que deja la línea en
 * `sin-codigo`.
 */
export function resolverCodigoVarios(
  texto: string,
  correccion: string,
  admitidos: { codigo: number }[],
  aprendidos: Record<string, string> = {},
): string {
  const t = texto.trim()
  const corregido = correccion.trim()

  // Compatibilidad con los comprobantes anteriores al cambio, que tienen el
  // codigo guardado en el campo del texto. Sin esto quedarian todos en
  // 'sin-codigo' y bloquearian su registro, que es peor que la
  // inconsistencia que arrastran.
  const codigoLegado =
    !corregido && /^\d+$/.test(t) && admitidos.some((c) => String(c.codigo) === t) ? t : ''

  // El SIRTAC lo resuelve la app sin que nadie se lo enseñe: es un regimen
  // conocido que aparece en casi todos los resumenes de tarjeta, de
  // cualquier banco o procesadora. Se reconoce por la sigla, que es lo unico
  // estable -- el resto del rotulo cambia con cada emisor ("Ret.IB SIRTAC",
  // "RETENCION IIBB SIRTAC", "Retencion I.B. /SIRTAC", "Regimen de
  // Retencion SIRTAC", todas vistas en comprobantes reales).
  const esSirtac = t !== '' && normalizar(t).includes('sirtac')

  return (
    corregido ||
    codigoLegado ||
    (t ? (aprendidos[normalizar(t)] ?? '') : '') ||
    (esSirtac ? COD_VARIOS_SIRTAC : '')
  )
}

/**
 * Resuelve los dos slots de impuestos varios, con el mismo mecanismo que
 * las percepciones: `variosN` trae el rótulo impreso ("Trib. emerg.
 * munic.", "Retención TEM", "Deduc. Impositivas") y el código de Tango sale
 * de la corrección del operador o de lo que ese proveedor ya enseñó.
 *
 * Hasta 2026-09-04 `variosN` guardaba el código directamente, así que no
 * había ningún texto contra el cual aprender y la elección del operador se
 * perdía en cada comprobante: lo reportó el usuario con dos liquidaciones
 * seguidas de Tarjeta Naranja, donde eligió el impuesto municipal a mano en
 * una y la siguiente volvió a venir sin código.
 *
 * El orden de precedencia es el mismo que en IVA e IIBB: lo que el operador
 * corrigió en este comprobante gana sobre lo aprendido del proveedor.
 */
export function resolverVarios(
  valores: Record<string, string | null | undefined>,
  codigosImpuesto: CodigoTango[],
  aprendidos: Record<string, string> = {},
): LineaVarios[] {
  const admitidos = codigosVarios(codigosImpuesto)
  const lineas: LineaVarios[] = []

  for (let slot = 1; slot <= MAX_SLOTS_VARIOS; slot++) {
    const importe = parsearImporte(valores[`impvarios${slot}`])
    if (importe <= 0) continue

    const texto = (valores[`varios${slot}`] ?? '').trim()
    const correccion = (valores[`codvarios${slot}`] ?? '').trim()

    const codigo = resolverCodigoVarios(texto, correccion, admitidos, aprendidos)
    const encontrado = admitidos.find((c) => String(c.codigo) === codigo)
    lineas.push({
      slot,
      codigo,
      texto,
      importe,
      estado: encontrado ? 'registra' : 'sin-codigo',
      descripcion: encontrado ? encontrado.descripcion : null,
    })
  }

  return lineas
}
