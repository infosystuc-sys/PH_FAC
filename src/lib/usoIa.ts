/**
 * Los tokens que consume cada lectura con IA y lo que cuestan (2026-11-03,
 * pendiente "costo de IA por comprobante" de RETOMAR.md).
 *
 * Se guardan los cuatro contadores que devuelve la API por separado, y no
 * un costo ya calculado, porque cada uno se cobra distinto y los precios
 * cambian: con los tokens guardados, el costo se puede recalcular después
 * para cualquier tarifa.
 *
 * - `entrada`: los tokens de entrada que NO salieron de caché (el PDF, el
 *   texto del pedido). Es el grueso.
 * - `cacheLectura`: el prompt de sistema leído del caché (la cabecera lo
 *   marca con `cache_control`).
 * - `cacheEscritura`: el prompt de sistema escrito al caché, la primera vez
 *   o cuando venció.
 * - `salida`: lo que genera el modelo, pensamiento incluido.
 */
export type UsoTokens = {
  entrada: number
  salida: number
  cacheLectura: number
  cacheEscritura: number
}

/** Lo que trae `response.usage` del SDK. Los campos de caché pueden venir en null. */
type UsageApi = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export function usoDeRespuesta(u: UsageApi | null | undefined): UsoTokens | undefined {
  if (!u) return undefined
  return {
    entrada: u.input_tokens ?? 0,
    salida: u.output_tokens ?? 0,
    cacheLectura: u.cache_read_input_tokens ?? 0,
    cacheEscritura: u.cache_creation_input_tokens ?? 0,
  }
}

/** Dólares por millón de tokens. */
type Tarifa = { entrada: number; salida: number; cacheLectura: number; cacheEscritura: number }

/**
 * Tarifas de lista de la API de Anthropic (octubre 2026). La escritura de
 * caché (TTL de 5 minutos, el que usa la app) es 1,25x la entrada; la
 * lectura, 0,1x en Opus 5 y 0,20 USD fijo en Opus 5.5. Un
 * modelo que no esté acá no tiene costo calculado: el informe muestra los
 * tokens igual.
 */
const TARIFAS: Record<string, Tarifa> = {
  'claude-opus-5': { entrada: 5, salida: 25, cacheLectura: 0.5, cacheEscritura: 6.25 },
  'claude-opus-5-5': { entrada: 4, salida: 20, cacheLectura: 0.2, cacheEscritura: 5 },
}

/** El costo en dólares de un uso, o null si el modelo no tiene tarifa cargada. */
export function costoUsd(modelo: string | null, uso: UsoTokens): number | null {
  const t = modelo ? TARIFAS[modelo] : undefined
  if (!t) return null
  return (
    (uso.entrada * t.entrada +
      uso.salida * t.salida +
      uso.cacheLectura * t.cacheLectura +
      uso.cacheEscritura * t.cacheEscritura) /
    1_000_000
  )
}
