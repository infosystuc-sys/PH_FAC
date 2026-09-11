import { parsearImporte } from './formato'
import {
  JURISDICCIONES_IIBB,
  resolverIibbPorTipo,
  buscarAprendido,
  type CodigoPercepcion,
} from './percepcionIibb'

export type { CodigoPercepcion }

export const MAX_SLOTS_PERCEPCION = 4
export const MAX_SLOTS_VARIOS = 2

/** Un código de CPA14 tal como lo devuelve `listarCodigosImpuesto`. */
export type CodigoTango = { codigo: number; descripcion: string }

export type EstadoLinea = 'registra' | 'sin-codigo'


export type LineaPercepcion = {
  slot: number
  /** La jurisdicción tal como la leyó la IA del comprobante. */
  texto: string
  importe: number
  estado: EstadoLinea
  codigo: CodigoPercepcion | null
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
 * Los códigos que la app admite en "Impuestos varios": todos los de CPA14
 * que no son alícuota de IVA, tal como los devuelve `listarCodigosImpuesto`.
 *
 * Ya no filtra nada. Hasta el 2026-09-09 escondía las cinco jurisdicciones
 * de Ingresos Brutos, con el argumento de que su lugar es `percepN` y
 * ofrecerlas acá sería darle al operador dos formas de cargar lo mismo. El
 * usuario pidió primero el 64 y después habilitar todas: el criterio pasa a
 * ser que el operador vea todo lo que Tango admite y elija, en vez de que la
 * app decida por él qué puede elegir.
 *
 * Se mantiene como función --y no se llama directo a `listarCodigosImpuesto`
 * en cada pantalla-- porque es el lugar donde está escrito qué se ofrece en
 * esta familia: si mañana hay que volver a acotar algo, se acota acá una vez
 * y no en los tres lugares que arman la lista.
 */
export function codigosVarios<T extends { codigo: number }>(codigosImpuesto: T[]): T[] {
  return [...codigosImpuesto]
}

/**
 * Los códigos que la app admite en los slots de percepción de Ingresos
 * Brutos. Son los mismos que en varios: las dos familias escriben en CPA18,
 * y desde el 2026-09-09 el operador puede corregir a cualquiera de los dos
 * lados -- pedido del usuario.
 *
 * Cómo resuelve la app sola es otra cosa y vive en `resolverIibbPorTipo`:
 * primero lo que este proveedor ya enseñó para ese rótulo, y si no hay nada
 * aprendido, la lista curada de `JURISDICCIONES_IIBB` (y en tarjeta, el 64).
 * Esta lista es de qué puede ELEGIR el operador, que es todo.
 */
export function codigosPercepcion<T extends { codigo: number }>(codigosImpuesto: T[]): T[] {
  return [...codigosImpuesto]
}

/**
 * Resuelve los cuatro slots de percepción. Igual que con las alícuotas de
 * IVA, la usan los dos lados -- el panel de la revisión y el armado de
 * CPA18 -- para que no puedan discrepar.
 *
 * Solo entran los slots con importe > 0: una jurisdicción sin importe no
 * genera línea, no hay nada que grabar.
 *
 * `codigosImpuesto` es el maestro de CPA14 y sirve para una sola cosa:
 * aceptar una corrección del operador a un código que no es una de las cinco
 * jurisdicciones (2026-09-09, pedido del usuario). Es opcional para no
 * obligar a los tests puros a traer el maestro, pero los tres llamadores
 * reales lo pasan -- si alguno no lo hiciera, el desplegable ofrecería un
 * código que después la resolución rechazaría, que es justo la clase de
 * divergencia entre pantalla y registro que esta función existe para evitar.
 */
export function resolverPercepciones(
  valores: Record<string, string | null | undefined>,
  tipoFactura?: string | null,
  aprendidos?: Record<string, string>,
  codigosImpuesto?: CodigoTango[],
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
      ? resolverCorreccionPercepcion(correccion, codigosImpuesto)
      : resolverIibbPorTipo(texto, tipoFactura ?? valores.tipoFactura, aprendidos, codigosImpuesto)
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
 * El código al que el operador corrigió una percepción.
 *
 * Se busca primero entre las jurisdicciones para conservar su etiqueta
 * ("Tucumán" y no "PERCEPCION IIBB TUC", que es como la llama CPA14), y
 * recién después en el maestro. Un código que no está en ninguno de los dos
 * devuelve `null` y la línea queda en `sin-codigo`: el desplegable no lo
 * ofrece, así que llegar acá significa que el valor vino de otro lado.
 */
function resolverCorreccionPercepcion(
  correccion: string,
  codigosImpuesto?: CodigoTango[],
): CodigoPercepcion | null {
  const jurisdiccion = JURISDICCIONES_IIBB.find((j) => j.codigo === correccion)
  if (jurisdiccion) return jurisdiccion

  const enTango = codigosImpuesto?.find((c) => String(c.codigo) === correccion)
  return enTango ? { codigo: String(enTango.codigo), jurisdiccion: enTango.descripcion } : null
}

/**
 * A qué código de Tango va UNA línea de impuestos varios.
 *
 * Existe como función aparte porque la usan los dos lados -- `resolverVarios`,
 * que arma CPA18, y la celda "En Tango" del formulario -- y hasta el
 * 2026-09-06 la celda repetía esta precedencia a mano y se le había quedado
 * afuera un término. El efecto era que en una liquidación que nadie hubiera
 * corregido todavía el desplegable aparecía vacío y en rojo mientras el
 * registro imputaba a otra cosa: la pantalla decía una cosa y Tango recibía
 * otra. Lo reportó el usuario con las liquidaciones de Galicia, BBVA y
 * Credicoop.
 *
 * El orden es el mismo que en IVA e IIBB: lo que el operador corrigió en
 * este comprobante gana sobre lo aprendido para ese proveedor.
 *
 * **No hay regla general debajo.** Hasta el 2026-09-11 el SIRTAC se resolvía
 * solo: cualquier rótulo que contuviera la sigla iba a un código fijo, con el
 * argumento de que es un régimen conocido que aparece en casi todos los
 * resúmenes de tarjeta. Esa constante dio cuatro vueltas -- 56, 63, 67, 64 --
 * porque el código correcto no se deduce de la sigla: lo define la tabla de
 * imputación del usuario, que lo mapea por emisor. Con la tabla cargada la
 * regla ya no agrega nada donde acierta y contradice donde no, así que se
 * fue: un rótulo sin fila en la tabla deja la línea en `sin-codigo`, la
 * imputa el operador y esa elección se aprende para ese proveedor. Decisión
 * del usuario del 2026-09-11.
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

  return corregido || codigoLegado || (t ? (buscarAprendido(aprendidos, t) ?? '') : '')
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
