import { parsearImporte } from './formato'
import {
  JURISDICCIONES_IIBB,
  resolverIibbPorTipo,
  type CodigoIibb,
} from './percepcionIibb'

export const MAX_SLOTS_PERCEPCION = 4
export const MAX_SLOTS_VARIOS = 2

/**
 * El codigo de "Impuestos varios" al que va el SIRTAC de un resumen de
 * tarjeta.
 *
 * OJO: en CPA14 el 56 es "RETENCION MUNICIPAL" y existe un 67 que se llama
 * "RET SIRTAC". El 56 esta puesto a proposito -- decision de registracion
 * del usuario, confirmada el 2026-08-17 despues de mostrarle las dos
 * opciones. No es un error de tipeo: si alguien lo "corrige" al 67, cambia
 * la imputacion contable de todos los resumenes de tarjeta.
 */
export const COD_VARIOS_SIRTAC = '56'

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
  /** El código que eligió el operador (o sugirió la IA). */
  codigo: string
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
      : resolverIibbPorTipo(texto, tipoFactura ?? valores.tipoFactura)
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
 * Resuelve los dos slots de impuestos varios. Acá el operador elige el
 * código de una lista, así que no hay nada que interpretar: solo se
 * verifica que el elegido siga siendo uno de los admitidos -- podría
 * venir de la IA, o haber quedado guardado de antes y ya no estar en
 * CPA14.
 */
export function resolverVarios(
  valores: Record<string, string | null | undefined>,
  codigosImpuesto: CodigoTango[],
): LineaVarios[] {
  const admitidos = codigosVarios(codigosImpuesto)
  const lineas: LineaVarios[] = []

  for (let slot = 1; slot <= MAX_SLOTS_VARIOS; slot++) {
    const importe = parsearImporte(valores[`impvarios${slot}`])
    if (importe <= 0) continue

    const codigo = (valores[`varios${slot}`] ?? '').trim()
    const encontrado = admitidos.find((c) => String(c.codigo) === codigo)
    lineas.push({
      slot,
      codigo,
      importe,
      estado: encontrado ? 'registra' : 'sin-codigo',
      descripcion: encontrado ? encontrado.descripcion : null,
    })
  }

  return lineas
}
