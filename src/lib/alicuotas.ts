import { parsearImporte } from './formato'

export const MAX_SLOTS_IVA = 5

/**
 * El 3% es el único porcentaje ambiguo de CPA14: lo tienen el 15
 * ("PERCEPCION R.G.3337") y el 16 ("PERCEP. DE IVA"). La norma es usar
 * siempre el 15, sin pedirle al operador que elija.
 */
export const CODIGO_IVA_PREFERIDO = 15

export type AlicuotaTango = {
  codigo: number
  porcentaje: number
  descripcion: string
}

/**
 * - `registra`: se graba en un slot COD_IVA/PORC_IVA/IMP_IVA de CPA04.
 * - `omitida`: alícuota 0%. Norma de registración: no se registra.
 * - `sin-codigo`: el porcentaje no existe en CPA14, así que no hay nada
 *   que grabar. Bloquea el registro.
 */
export type EstadoLinea = 'registra' | 'omitida' | 'sin-codigo'

export type LineaAlicuota = {
  slot: number
  porcentaje: number
  importe: number
  estado: EstadoLinea
  alicuota: AlicuotaTango | null
}

/** Resuelve un porcentaje leído del comprobante al COD_IVA de CPA14. */
export function resolverCodigoIva(
  porcentaje: number,
  alicuotas: AlicuotaTango[],
): AlicuotaTango | null {
  const candidatos = alicuotas.filter((a) => a.porcentaje === porcentaje)
  if (candidatos.length === 0) return null
  if (candidatos.length === 1) return candidatos[0]
  return candidatos.find((a) => a.codigo === CODIGO_IVA_PREFERIDO) ?? null
}

/**
 * Resuelve los cinco pares porcivaN/impivaN contra las alícuotas de Tango.
 *
 * La usan los dos lados -- el panel de "listo para registrar" y el armado
 * real de CPA04 -- a propósito: si cada uno resolviera por su cuenta, el
 * panel podría decir "listo" y el registro fallar igual, que es
 * exactamente el problema que esto viene a cerrar. Cualquier cambio de
 * criterio (qué se omite, cómo se desempata) se hace acá una sola vez.
 *
 * Solo entran los slots con importe > 0: un par sin importe no se graba,
 * no hay nada que resolver.
 */
export function resolverAlicuotas(
  valores: Record<string, string | null | undefined>,
  alicuotas: AlicuotaTango[],
): LineaAlicuota[] {
  const lineas: LineaAlicuota[] = []

  for (let slot = 1; slot <= MAX_SLOTS_IVA; slot++) {
    const importe = parsearImporte(valores[`impiva${slot}`])
    if (importe <= 0) continue

    const porcentaje = parsearImporte(valores[`porciva${slot}`])

    // El codigo corregido a mano gana sobre lo que resuelve el porcentaje:
    // existe justamente para los casos en que la resolucion automatica no
    // sirve (el 3% es ambiguo entre el 15 y el 16, por ejemplo). Tambien
    // gana sobre la regla del 0%: si el operador eligio un codigo, quiso
    // registrar esa linea.
    const correccion = (valores[`codiva${slot}`] ?? '').trim()
    if (correccion) {
      const elegida = alicuotas.find((a) => String(a.codigo) === correccion) ?? null
      lineas.push({
        slot,
        porcentaje,
        importe,
        estado: elegida ? 'registra' : 'sin-codigo',
        alicuota: elegida,
      })
      continue
    }

    if (porcentaje === 0) {
      lineas.push({ slot, porcentaje, importe, estado: 'omitida', alicuota: null })
      continue
    }

    const alicuota = resolverCodigoIva(porcentaje, alicuotas)
    lineas.push({
      slot,
      porcentaje,
      importe,
      estado: alicuota ? 'registra' : 'sin-codigo',
      alicuota,
    })
  }

  return lineas
}

/** Formatea un porcentaje como lo escribe el operador: 21, 10,5. */
export function formatPorcentaje(p: number): string {
  return `${String(p).replace('.', ',')}%`
}
