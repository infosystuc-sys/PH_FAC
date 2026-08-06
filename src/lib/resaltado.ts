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

/**
 * Longitud mínima para resaltar, para cualquier tipo de valor: con menos,
 * se resaltaría medio PDF. Sigue aplicando también a los numéricos, además
 * de la regla de límite de número (`matcheaSinFlanqueoNumerico`): un solo
 * dígito como el de `porciva3` (alícuota "3", sin decimales) no tiene
 * ningún límite que lo salve, porque un dígito suelto aparece por todos
 * lados en un comprobante real -- verificado contra un PDF real de este
 * proyecto, la alícuota "3" resaltaba 6 lugares sin relación (nombres de
 * plan como "Plan Control 3GB", una cláusula de interés "3% mensual"), no
 * solo la fila de IVA que se buscaba.
 */
const MINIMO = 2

const SOLO_DIGITOS = /^\d+$/

/**
 * Para buscados puramente numéricos, ningún mínimo de longitud separa bien
 * los dos casos reales del catálogo:
 *
 * - `porciva1`/`porciva2` (alícuotas de IVA) llegan como "21.0"/"27.0", que
 *   normalizados quedan "210"/"270" -- y esos tres dígitos aparecen por
 *   pura coincidencia dentro de cualquier importe del bloque de totales
 *   que los contenga (p. ej. "1.210,50" ya trae el "210").
 * - `cotizacion` llega como "1,00", que normalizado es "100" -- exactamente
 *   la misma longitud que el caso anterior, pero acá SÍ hace falta que
 *   resalte: es un campo `mono`, decimal, extraído por la IA, del tipo que
 *   el operador cotejá contra el PDF todo el tiempo.
 *
 * Con cualquier mínimo fijo, o se resuelven los dos, o no se resuelve
 * ninguno. Lo que distingue un caso del otro no es cuántos dígitos tiene
 * el valor buscado, sino si esos dígitos son *todo* el número donde
 * aparecen o son un fragmento de uno más largo. "210" en "1.210,50" tiene
 * un "1" antes y un "5" después: es parte de otro número. "100" en
 * "1,00" no tiene ningún dígito ni antes ni después: es el número
 * completo. Por eso la regla es de límite de número (boundary), no de
 * longitud: la coincidencia vale si el carácter inmediatamente anterior y
 * el inmediatamente posterior -- cuando existen -- no son dígitos.
 */
function matcheaSinFlanqueoNumerico(textoNormalizado: string, buscadoNormalizado: string): boolean {
  let desde = 0
  for (;;) {
    const i = textoNormalizado.indexOf(buscadoNormalizado, desde)
    if (i === -1) return false

    const antes = i > 0 ? textoNormalizado[i - 1] : ''
    const despues =
      i + buscadoNormalizado.length < textoNormalizado.length
        ? textoNormalizado[i + buscadoNormalizado.length]
        : ''
    if (!/\d/.test(antes) && !/\d/.test(despues)) return true

    // Esta ocurrencia está pegada a otro número: puede haber otra más
    // adelante en el mismo span que sí sea un límite válido.
    desde = i + 1
  }
}

export function coincide(textoSpan: string, buscado: string): boolean {
  const b = normalizarParaBusqueda(buscado)
  if (b.length < MINIMO) return false
  const t = normalizarParaBusqueda(textoSpan)
  if (t.length === 0) return false

  if (SOLO_DIGITOS.test(b)) return matcheaSinFlanqueoNumerico(t, b)
  return t.includes(b)
}
