/**
 * Números de serie de un renglón de remito (2026-11-04, pedido del usuario).
 *
 * Un artículo con `STA11.USA_SERIE` lleva una serie por unidad: Tango no
 * deja entrarlo al stock sin ellas. Cada una va a una fila de `STA07`
 * (historial del movimiento) y a una de `STA06` (las series en stock). En
 * los 1.444 renglones `RP` que Tango ya grabó, `DESC1` y `DESC2` vienen
 * siempre cargados (en las motos, el número de motor y el color) y
 * `COMENTARIO` en 1.044 (el número de certificado); `N_SERIE` es el
 * obligatorio: es parte de la clave única de las dos tablas.
 *
 * Los largos son los de esas columnas en Tango.
 */
export const LARGO_SERIE = { nSerie: 30, desc1: 25, desc2: 25, comentario: 25 } as const

export type Serie = {
  nSerie: string
  desc1: string
  desc2: string
  comentario: string
}

/** Recorta espacios y pasa la serie a mayúsculas, como la muestra Tango. */
export function normalizarSerie(s: Partial<Serie>): Serie {
  return {
    nSerie: (s.nSerie ?? '').trim().toUpperCase(),
    desc1: (s.desc1 ?? '').trim(),
    desc2: (s.desc2 ?? '').trim(),
    comentario: (s.comentario ?? '').trim(),
  }
}

/**
 * Lo que está mal en las series de un renglón, o `null` si están completas.
 * La cantidad tiene que ser entera (no hay media unidad con número de serie)
 * y tiene que haber exactamente una serie por unidad, sin repetir.
 */
export function problemaSeries(codArticu: string, cantidad: number, series: Serie[]): string | null {
  if (!Number.isInteger(cantidad) || cantidad <= 0) {
    return `El artículo ${codArticu} usa número de serie y la cantidad ${cantidad} no es una cantidad entera de unidades.`
  }
  const cargadas = series.filter((s) => s.nSerie !== '')
  if (cargadas.length !== cantidad) {
    return `El artículo ${codArticu} usa número de serie: tiene ${cargadas.length} de ${cantidad} cargado(s).`
  }
  for (const s of cargadas) {
    if (s.nSerie.length > LARGO_SERIE.nSerie) {
      return `La serie ${s.nSerie} del artículo ${codArticu} tiene más de ${LARGO_SERIE.nSerie} caracteres.`
    }
    if (
      s.desc1.length > LARGO_SERIE.desc1 ||
      s.desc2.length > LARGO_SERIE.desc2 ||
      s.comentario.length > LARGO_SERIE.comentario
    ) {
      return `La serie ${s.nSerie} del artículo ${codArticu} tiene una descripción o un comentario de más de 25 caracteres.`
    }
  }
  const vistas = new Set<string>()
  for (const s of cargadas) {
    if (vistas.has(s.nSerie)) return `La serie ${s.nSerie} del artículo ${codArticu} está repetida.`
    vistas.add(s.nSerie)
  }
  return null
}
