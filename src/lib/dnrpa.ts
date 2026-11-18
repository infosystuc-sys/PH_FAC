/**
 * Importar el DNRPA de las motos desde el mail del proveedor (2026-11-18,
 * pedido del usuario): "En el archivo tenés la columna NRO DE CHASIS, que es
 * el número de serie que tenés que buscar en STA06 y STA07. Una vez que lo
 * encuentres, modificá el campo COMENTARIO en ambas tablas con el valor de la
 * columna NRO DNRPA".
 *
 * El remito se registra sin el DNRPA desde el 2026-11-18 (se carga después):
 * en ese caso `COMENTARIO` queda con la propia serie, igual que hace Tango
 * cuando el operador no lo carga. Eso, o vacío, es "sin DNRPA" y se
 * reemplaza. Cualquier otro valor distinto del que trae el archivo es de
 * otro dato y NO se toca (decisión del usuario: mostrar y no tocar).
 *
 * Lógica pura: la consulta a Tango está en `src/server/tango/dnrpa.ts`.
 */

/** El largo de `STA06.COMENTARIO` / `STA07.COMENTARIO`. */
export const LARGO_COMENTARIO = 25

/** El chasis como se guarda la serie: sin espacios y en mayúsculas. */
export function normalizarChasis(texto: string | null | undefined): string {
  return (texto ?? '').replace(/\s+/g, '').toUpperCase()
}

/** El DNRPA tal como viene impreso, sin espacios de más ("M-0000903599/2026"). */
export function normalizarDnrpa(texto: string | null | undefined): string {
  return (texto ?? '').replace(/\s+/g, '').toUpperCase()
}

/** Una fila de STA06 o STA07 con esa serie. */
export type FilaSerie = {
  tabla: 'STA06' | 'STA07'
  codArticu: string
  comentario: string
}

export type EstadoDnrpa =
  | 'cargar' // se graba
  | 'igual' // ya tenía este DNRPA: nada que hacer
  | 'otro' // ya tiene otro comentario: no se toca
  | 'no-encontrada' // la serie no está en Tango
  | 'varios-articulos' // la serie está en más de un artículo: no se toca
  | 'repetida' // el archivo trae el mismo chasis con dos DNRPA distintos
  | 'invalida' // falta el chasis o el DNRPA, o el DNRPA no entra en la columna

export type ClasificacionDnrpa = {
  estado: EstadoDnrpa
  /** El artículo de la serie, si es uno solo. */
  codArticu: string | null
  /** Lo que tiene hoy `COMENTARIO` cuando no es la serie ni está vacío. */
  comentarioActual: string | null
  /** Cuántas filas se actualizan (STA06 + STA07). */
  filas: number
}

/** Un comentario que no es un dato: vacío o la propia serie. */
export function esSinDnrpa(comentario: string, chasis: string): boolean {
  const c = normalizarChasis(comentario)
  return c === '' || c === chasis
}

/**
 * Qué hacer con una fila del archivo, mirando todas las filas de STA06 y
 * STA07 de esa serie. Solo `cargar` escribe, y solo en las filas sin DNRPA.
 */
export function clasificarDnrpa(chasis: string, dnrpa: string, filas: FilaSerie[]): ClasificacionDnrpa {
  const base = { codArticu: null, comentarioActual: null, filas: 0 }
  if (!chasis || !dnrpa || dnrpa.length > LARGO_COMENTARIO) return { estado: 'invalida', ...base }
  if (filas.length === 0) return { estado: 'no-encontrada', ...base }

  const articulos = [...new Set(filas.map((f) => f.codArticu.trim()))]
  if (articulos.length > 1) return { estado: 'varios-articulos', ...base }
  const codArticu = articulos[0]

  const otro = filas.find(
    (f) => !esSinDnrpa(f.comentario, chasis) && normalizarDnrpa(f.comentario) !== dnrpa,
  )
  if (otro) return { estado: 'otro', codArticu, comentarioActual: otro.comentario.trim(), filas: 0 }

  const aCargar = filas.filter((f) => esSinDnrpa(f.comentario, chasis)).length
  if (aCargar === 0) return { estado: 'igual', codArticu, comentarioActual: null, filas: 0 }
  return { estado: 'cargar', codArticu, comentarioActual: null, filas: aCargar }
}

/**
 * Las filas del archivo, sin repetir: el mismo chasis con el mismo DNRPA
 * cuenta una vez; con dos DNRPA distintos, ninguno se graba.
 */
export function deduplicarDnrpa<T extends { chasis: string; dnrpa: string }>(
  filas: T[],
): { fila: T; repetidaConOtro: boolean }[] {
  const porChasis = new Map<string, { fila: T; dnrpas: Set<string> }>()
  for (const f of filas) {
    const previo = porChasis.get(f.chasis)
    if (previo) previo.dnrpas.add(f.dnrpa)
    else porChasis.set(f.chasis, { fila: f, dnrpas: new Set([f.dnrpa]) })
  }
  return [...porChasis.values()].map((x) => ({ fila: x.fila, repetidaConOtro: x.dnrpas.size > 1 }))
}

export const ETIQUETA_DNRPA: Record<EstadoDnrpa, string> = {
  cargar: 'Se carga',
  igual: 'Ya tenía este DNRPA',
  otro: 'Ya tiene otro comentario',
  'no-encontrada': 'No está en Tango',
  'varios-articulos': 'En más de un artículo',
  repetida: 'Repetida con otro DNRPA',
  invalida: 'Dato incompleto',
}
