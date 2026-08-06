/**
 * Normaliza para comparar el valor de un campo contra la capa de texto del
 * PDF. Saca todo lo que puede diferir entre cómo la IA devolvió el dato y
 * cómo está impreso: acentos, espacios, guiones, puntos y comas. Un CUIT
 * "30-71042636-9" tiene que matchear contra "30710426369" impreso.
 */
export function normalizarParaBusqueda(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s.,\-/]/g, '')
}

/** Longitud mínima para resaltar: con menos, se resaltaría medio PDF. */
const MINIMO = 2

/**
 * Piso más alto para valores puramente numéricos (después de normalizar).
 *
 * El mínimo general de 2 no alcanza para ellos: hay campos como `porciva1`
 * cuyo valor real es "21.0" (una alícuota de IVA) y que normalizado queda
 * "210" -- tres dígitos que aparecen por pura coincidencia dentro de
 * cualquier importe del bloque de totales (un importe como "1.210,50" ya
 * lo contiene). El alfabeto de un número son 10 símbolos contra los 26 de
 * una cadena de texto, y un comprobante está lleno de números (importes,
 * CUIT, fechas, CAE): a igual longitud, una secuencia corta de dígitos
 * choca mucho más seguido que una de letras. Con este piso más alto, una
 * alícuota como "21.0" simplemente no resalta nada -- que es preferible a
 * resaltar un importe al azar.
 */
const MINIMO_NUMERICO = 4

const SOLO_DIGITOS = /^\d+$/

export function coincide(textoSpan: string, buscado: string): boolean {
  const b = normalizarParaBusqueda(buscado)
  const minimo = SOLO_DIGITOS.test(b) ? MINIMO_NUMERICO : MINIMO
  if (b.length < minimo) return false
  const t = normalizarParaBusqueda(textoSpan)
  if (t.length === 0) return false
  return t.includes(b)
}
