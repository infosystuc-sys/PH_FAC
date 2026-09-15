import { camposDelGrupo } from './campos'

const MONEDA = new Intl.NumberFormat('es-AR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoneda(n: number | null | undefined): string {
  if (n === null || n === undefined || n === 0) return '—'
  return `$ ${MONEDA.format(n)}`
}

/**
 * Igual que `formatMoneda` (mismo separador de miles/decimales es-AR) pero
 * sin el símbolo `$`, para cantidades -- la columna "Cant." de un renglón
 * no es un importe, y anteponerle "$" leería como si lo fuera.
 */
export function formatCantidad(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return MONEDA.format(n)
}

export function formatFecha(d: Date | string | null | undefined): string {
  if (!d) return '—'
  const f = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d
  if (Number.isNaN(f.getTime())) return '—'
  const dd = String(f.getDate()).padStart(2, '0')
  const mm = String(f.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${f.getFullYear()}`
}

export function normalizarCuit(c: string | null | undefined): string | null {
  if (!c) return null
  const soloDigitos = c.replace(/\D/g, '')
  return soloDigitos.length === 11 ? soloDigitos : null
}

export function formatCuit(c: string | null | undefined): string {
  if (!c) return '—'
  const n = normalizarCuit(c)
  if (!n) return c
  return `${n.slice(0, 2)}-${n.slice(2, 10)}-${n.slice(10)}`
}

/**
 * Interpreta un importe tal como lo devuelve la IA. Los comprobantes
 * reales mezclan formatos en el mismo PDF -- una factura vista puede traer
 * "186623.75" (sin separador de miles) al lado de "39.190,99" (formato
 * argentino) -- así que no alcanza con asumir un único separador decimal.
 *
 * Reglas:
 * - Si tiene punto y coma, el que aparece último en la cadena es el
 *   separador decimal; el otro es de miles.
 * - Si tiene solo coma, la coma es el separador decimal.
 * - Si tiene solo punto: un único punto seguido de exactamente tres dígitos
 *   es separador de miles ("186.623"); cualquier otra cantidad de dígitos
 *   (1, 2, 4 o más) es decimal ("2.5", "186623.75", "12.3456"), y varios
 *   puntos son siempre separador de miles ("1.186.623"). Un caso como
 *   "1.234" es ambiguo -- ¿mil doscientos treinta y cuatro, o uno coma dos
 *   tres cuatro? -- y se resuelve como separador de miles: la agrupación de
 *   a tres es con diferencia el formato más común en los comprobantes
 *   reales que llegan (miles en pesos o dólares), y un decimal de exactamente
 *   3 cifras es raro en un importe de factura.
 * - Lo que no da un número finito vuelve `null`, no `0`, para que el
 *   llamador pueda distinguir "no se pudo leer" de "el importe es cero".
 */
function normalizarImporte(v: string): number | null {
  const t = v.trim()
  if (t === '') return null

  const tienePunto = t.includes('.')
  const tieneComa = t.includes(',')

  let normalizado: string
  if (tienePunto && tieneComa) {
    normalizado =
      t.lastIndexOf(',') > t.lastIndexOf('.')
        ? t.replace(/\./g, '').replace(',', '.')
        : t.replace(/,/g, '')
  } else if (tieneComa) {
    const i = t.lastIndexOf(',')
    normalizado = `${t.slice(0, i).replace(/,/g, '')}.${t.slice(i + 1)}`
  } else if (tienePunto) {
    const partes = t.split('.')
    // Un unico punto es decimal salvo que tenga exactamente 3 digitos
    // detras (ahi es separador de miles, ver el comentario de arriba).
    // Mas de un punto es siempre separador de miles: no hay forma de que
    // un numero tenga dos separadores decimales.
    const esDecimalUnico = partes.length === 2 && partes[1].length !== 3
    normalizado = esDecimalUnico ? t : t.replace(/\./g, '')
  } else {
    normalizado = t
  }

  const n = Number(normalizado)
  return Number.isFinite(n) ? n : null
}

/**
 * Como `normalizarImporte`, pero para los puntos donde una lectura que no
 * parsea tiene que dejar la columna en NULL en vez de contaminarla con un
 * 0 falso -- por ejemplo, un total ilegible no es un total de $0.
 */
export function parsearImporteONulo(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return normalizarImporte(v)
}

/**
 * Version que nunca devuelve `null`: para sumar importes en JS, donde un
 * valor ausente o ilegible tiene que aportar 0 al acumulado en vez de
 * contaminarlo con `NaN`.
 */
export function parsearImporte(v: string | null | undefined): number {
  return parsearImporteONulo(v) ?? 0
}

/**
 * Claves del grupo "Importes" que entran en el total imputado. Se derivan
 * del catálogo -- no se hardcodea la lista -- para que agregar o sacar un
 * campo de ese grupo no desincronice la suma:
 *
 * - Se excluyen los `porcivaN`: el catálogo los marca `tipo: 'porcentaje'`,
 *   no `decimal`, justamente para que esta suma los pueda descartar sin
 *   nombrarlos uno por uno. Son alícuotas (21, 27, 3...), no importes,
 *   y sumarlos daría un total que parece razonable pero está mal por
 *   unas decenas.
 * - Se excluye `imputado`: es el resultado de esta misma suma (de sólo
 *   lectura), no un componente de ella.
 * - Se excluye `total`: es el total leído del PDF. El imputado existe
 *   justamente para contrastarlo contra esa lectura; sumarlo lo
 *   duplicaría.
 * - Se excluye `descuentogeneral`: no es un componente del total sino un
 *   dato informativo que ya está resuelto ADENTRO del neto gravado (ver
 *   descuentoGlobal.ts: o los subtotales ya lo tienen aplicado, o se resta
 *   de ellos para llegar al neto -- en los dos casos el neto que se suma
 *   acá ya es neto). Sumarlo lo cobraba dos veces: el usuario lo vio en
 *   ZOZZOLI el 2026-09-15, con un imputado que superaba al total en
 *   exactamente 2 x 107.843,06.
 */
const NO_SUMAN_AL_IMPUTADO = new Set(['total', 'descuentogeneral'])

const CLAVES_IMPUTADO = camposDelGrupo('importes')
  .filter((c) => c.tipo === 'decimal' && !c.soloLectura && !NO_SUMAN_AL_IMPUTADO.has(c.clave))
  .map((c) => c.clave)

export function totalImputado(valores: Record<string, string | null | undefined>): number {
  return CLAVES_IMPUTADO.reduce((acc, clave) => acc + parsearImporte(valores[clave]), 0)
}
