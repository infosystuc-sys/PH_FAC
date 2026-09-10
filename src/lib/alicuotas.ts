import { parsearImporte, parsearImporteONulo } from './formato'
import { normalizar } from './percepcionIibb'

export const MAX_SLOTS_IVA = 5

/**
 * A qué código resuelve una percepción de IVA, que es el único caso donde
 * los slots de IVA necesitan desempate. Se usa en las dos situaciones que
 * lo piden, y las dos son percepciones:
 *
 * - El 3% es el único porcentaje ambiguo de CPA14: lo tienen el 15
 *   ("PERCEPCION R.G.3337") y el 16 ("PERCEP. DE IVA").
 * - Un importe sin porcentaje impreso, típico de las percepciones que las
 *   liquidaciones de tarjeta cobran sin declarar tasa.
 *
 * **Es el 16**, decisión del usuario del 2026-09-06. Hasta esa fecha era
 * el 15: la norma se había fijado el 2026-08-21 cuando el único caso a la
 * vista era el 3% ambiguo, y se revisó al aparecer la línea
 * "Percep./Retenc.AFIP - DGI" de las liquidaciones de tarjeta, que es una
 * percepción de IVA lisa y llana y le corresponde el código que se llama
 * así. Cambiarlo mueve la imputación contable de toda percepción de IVA.
 */
export const CODIGO_IVA_PREFERIDO = 16

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

/**
 * Si el contenido de `porcivaN` es un porcentaje y no un rótulo.
 *
 * El campo lleva las dos cosas: el porcentaje cuando la línea lo imprime, y
 * el rótulo cuando no ("IVA S/ARANCEL + COSTO FINANCIERO", "Retención IVA").
 * Se distingue por la forma del texto y no parseando: `parsearImporte` le
 * saca un número a cualquier cosa que tenga dígitos, y "IVA 21% DEC 879" es
 * un rótulo, no una tasa del 21 ni del 879.
 */
const RE_SOLO_PORCENTAJE = /^[\d.,\s%]+$/

export function esPorcentaje(texto: string): boolean {
  const t = texto.trim()
  return t !== '' && RE_SOLO_PORCENTAJE.test(t) && /\d/.test(t)
}

/**
 * La clave con la que se guarda y se busca lo aprendido de una línea de IVA.
 *
 * Un porcentaje se normaliza al número ("21,00" y "21.0" son la misma tasa);
 * un rótulo, al texto sin acentos ni mayúsculas, igual que las otras dos
 * familias. Tiene que coincidir con `normalizarDescripcion` en
 * `aprendizajeImpuestos.ts`, que es la que escribe: si divergieran, se
 * guardaría con una clave y se buscaría con otra.
 */
export function claveAprendidaIva(texto: string): string {
  const t = texto.trim()
  return esPorcentaje(t) ? String(parsearImporte(t)) : normalizar(t)
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

    const crudo = (valores[`porciva${slot}`] ?? '').trim()
    // `porcivaN` lleva el porcentaje cuando la linea lo imprime, y el rotulo
    // cuando no. Se distingue "0%" (una alicuota real de tasa cero) de "sin
    // porcentaje" (el comprobante no imprime tasa): parsearImporte por si
    // sola no puede --las dos dan 0-- y esa mezcla era un bug real, una
    // percepcion de IVA sin tasa propia caia en la regla del 0% y quedaba
    // omitida en vez de registrarse.
    const porcentajeLeido = esPorcentaje(crudo) ? parsearImporteONulo(crudo) : null
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

    // Lo aprendido para este proveedor y este rotulo, antes que cualquier
    // regla general -- misma precedencia que en percepciones y varios
    // (2026-09-10). Es lo unico que puede resolver una linea cuyo rotulo no
    // dice el porcentaje: "IVA S/ARANCEL + COSTO FINANCIERO" va al 1 y
    // "Retencion IVA" al 17, y ninguna de las dos se deduce de nada.
    const aprendido = crudo ? aprendidos?.[claveAprendidaIva(crudo)] : undefined
    const porAprendido = aprendido
      ? (alicuotas.find((a) => String(a.codigo) === aprendido) ?? null)
      : null
    if (porAprendido) {
      lineas.push({
        slot,
        porcentaje: porcentajeLeido ?? porAprendido.porcentaje,
        importe,
        estado: 'registra',
        alicuota: porAprendido,
      })
      continue
    }

    // Sin porcentaje impreso (no es 0%, es que no hay dato): casi siempre
    // una percepcion de IVA sin tasa propia, no una alicuota real. Se
    // resuelve directo a CODIGO_IVA_PREFERIDO, mismo criterio que ya usa el
    // 3% ambiguo. El porcentaje que se graba es el que ese codigo tiene en
    // Tango (CPA14), no un valor inventado.
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
