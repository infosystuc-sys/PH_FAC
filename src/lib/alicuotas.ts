import { parsearImporte, parsearImporteONulo } from './formato'

export const MAX_SLOTS_IVA = 5

/**
 * El 3% es el único porcentaje ambiguo de CPA14: lo tienen el 15
 * ("PERCEPCION R.G.3337") y el 16 ("PERCEP. DE IVA"). La norma es usar
 * siempre el 15, sin pedirle al operador que elija.
 */
export const CODIGO_IVA_PREFERIDO = 15

/**
 * Los COD_IVA de CPA14 que son IVA de verdad sobre la base gravada.
 * Verificado contra la tabla real de esta empresa, que devuelve siete
 * codigos: 1 (21%), 2 (0%), 3 (10,5%) y 4 (27%) son alicuotas de IVA; 15
 * ("PERCEPCION R.G.3337") y 16 ("PERCEP. DE IVA") son percepciones del 3%
 * que viajan en estos mismos slots por decision de registracion, y 17
 * ("RETENCION IVA") es una retencion.
 *
 * La distincion importa para `validarNetoContraIva`: el importe de una
 * percepcion o una retencion dividido por su porcentaje NO da una base
 * gravada, asi que sumarlo ahi inventaria neto que no existe.
 */
const CODIGOS_IVA_REALES = new Set([1, 2, 3, 4])

/** Si esta alicuota grava la base, o es una percepcion/retencion que viaja en los mismos slots. */
export function esIvaSobreLaBase(alicuota: AlicuotaTango | null): boolean {
  return alicuota !== null && CODIGOS_IVA_REALES.has(alicuota.codigo)
}

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

/**
 * Resuelve un porcentaje leído del comprobante al COD_IVA de CPA14.
 *
 * `aprendidos` es lo que un proveedor puntual ya le enseñó a la app
 * (`PHF_ALICUOTA_PROVEEDOR`): un porcentaje que hoy no tiene alícuota en
 * CPA14, o que tiene más de una sin que `CODIGO_IVA_PREFERIDO` desempate,
 * corregido una vez a mano. Se consulta último -- si el porcentaje ya
 * resuelve solo, gana eso, nunca lo aprendido.
 */
export function resolverCodigoIva(
  porcentaje: number,
  alicuotas: AlicuotaTango[],
  aprendidos?: Record<string, string>,
): AlicuotaTango | null {
  const candidatos = alicuotas.filter((a) => a.porcentaje === porcentaje)
  if (candidatos.length === 1) return candidatos[0]
  if (candidatos.length > 1) {
    const preferida = candidatos.find((a) => a.codigo === CODIGO_IVA_PREFERIDO)
    if (preferida) return preferida
  }

  const aprendido = aprendidos?.[String(porcentaje)]
  return aprendido ? (alicuotas.find((a) => String(a.codigo) === aprendido) ?? null) : null
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
  aprendidos?: Record<string, string>,
): LineaAlicuota[] {
  const lineas: LineaAlicuota[] = []

  for (let slot = 1; slot <= MAX_SLOTS_IVA; slot++) {
    const importe = parsearImporte(valores[`impiva${slot}`])
    if (importe <= 0) continue

    // Se distingue "0%" (texto "0", una alicuota real de tasa cero) de "sin
    // porcentaje" (texto vacio: el comprobante no imprime ninguna tasa para
    // esta linea). parsearImporte por si sola no puede -- las dos dan 0 --
    // y esa mezcla era un bug real: una percepcion de IVA sin tasa propia
    // (ej. "Percepcion IVA RG 2408", con importe > 0) caia en la regla del
    // 0% y quedaba omitida en vez de registrarse.
    const porcentajeLeido = parsearImporteONulo(valores[`porciva${slot}`])
    const porcentaje = porcentajeLeido ?? 0

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

    // Sin porcentaje impreso (no es 0%, es que no hay dato): casi siempre
    // una percepcion de IVA sin tasa propia, no una alicuota real. Se
    // resuelve directo al codigo preferido (15), mismo criterio que ya usa
    // el 3% ambiguo -- decision del usuario, 2026-08-21. El porcentaje que
    // se graba es el que ese codigo tiene en Tango (CPA14), no un valor
    // inventado.
    if (porcentajeLeido === null) {
      const preferida = alicuotas.find((a) => a.codigo === CODIGO_IVA_PREFERIDO) ?? null
      lineas.push({
        slot,
        porcentaje: preferida?.porcentaje ?? 0,
        importe,
        estado: preferida ? 'registra' : 'sin-codigo',
        alicuota: preferida,
      })
      continue
    }

    if (porcentaje === 0) {
      lineas.push({ slot, porcentaje, importe, estado: 'omitida', alicuota: null })
      continue
    }

    const alicuota = resolverCodigoIva(porcentaje, alicuotas, aprendidos)
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
