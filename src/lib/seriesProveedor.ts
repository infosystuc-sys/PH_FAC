import { restoDelCodigo } from './codigoProveedor'

/**
 * De dónde salen, en el comprobante de cada proveedor, los datos de los
 * números de serie que Tango guarda en `STA06`/`STA07` (2026-11-05, pedido
 * del usuario). La regla es por proveedor: cada uno imprime las unidades a
 * su manera, y el que no tiene regla carga las series a mano en la revisión.
 *
 * Correspondencia con Tango, la misma para todos los proveedores:
 *
 *   N_SERIE    número de serie (en las motos, el número de cuadro o chasis)
 *   DESC1      descripción adicional 1 (el número de motor)
 *   DESC2      descripción adicional 2 (el color de la unidad)
 *   COMENTARIO el DNRPA: lo carga siempre el operador, no sale del papel
 */

export type ReglaSeries = {
  /** Cómo se titula en el papel la columna que va a N_SERIE. Va al prompt. */
  columnaSerie: string
  /** Cómo se titula la columna que va a DESC1. Va al prompt. */
  columnaAdicional1: string
  /** DESC2 sale del código del artículo impreso, no de una columna. */
  adicional2DelCodigo: (codigoImpreso: string) => string
  /**
   * Cómo se titula la columna que va a COMENTARIO (el DNRPA), si el
   * proveedor lo imprime. Sin ella lo carga el operador (IMSA).
   */
  columnaComentario?: string
  /**
   * Columnas del papel que NO hay que leer y que el modelo podría confundir
   * con las de arriba. NEWSAN imprime "Nro Serie" al lado de "Nro VIN", y
   * lo que va a N_SERIE es el VIN.
   */
  columnasIgnorar?: string[]
}

/**
 * IMSA imprime el código del modelo como `MNTD-150NE-LLE2`: los 8 primeros
 * caracteres son el sinónimo del artículo en Tango (ver codigoProveedor.ts)
 * y lo que sigue hasta el próximo guion es el color (`NE`, `AZ`, `BL`).
 */
export function colorDelCodigoImsa(codigo: string): string {
  const resto = codigo.trim().slice(8)
  return resto.split('-')[0].trim()
}

/**
 * NEWSAN imprime el código con el color pegado (`CUBQU110BASEAZUL`): los 12
 * primeros caracteres son el modelo y lo que sigue, el color. Es la misma
 * regla con la que se busca el artículo (ver `restoDelCodigo`).
 */
export function colorDelCodigoNewsan(codigo: string): string {
  return restoDelCodigo('010003', codigo)
}

/**
 * IMPORTADORA MEDITERRANEA SA (IMSA, `010337`), decisión del usuario,
 * 2026-11-05. Cada renglón trae debajo una línea por unidad con las
 * columnas "Motor" y "Chasis".
 */
export const REGLAS_SERIES_POR_PROVEEDOR: Readonly<Record<string, ReglaSeries>> = {
  '010337': {
    columnaSerie: 'Chasis',
    columnaAdicional1: 'Motor',
    adicional2DelCodigo: colorDelCodigoImsa,
  },
  // NEWSAN (`010003`), decisión del usuario, 2026-11-16. Una línea por
  // unidad, con las columnas "Nro Serie", "Nro VIN", "Nro Motor" y "Nro
  // DNRPA": N_SERIE = VIN, DESC1 = motor, DESC2 = el color del código y
  // COMENTARIO = el DNRPA impreso. El "Nro Serie" no se usa.
  '010003': {
    columnaSerie: 'Nro VIN',
    columnaAdicional1: 'Nro Motor',
    adicional2DelCodigo: colorDelCodigoNewsan,
    columnaComentario: 'Nro DNRPA',
    columnasIgnorar: ['Nro Serie'],
  },
}

export function reglaSeriesDe(codProvee: string | null | undefined): ReglaSeries | null {
  return REGLAS_SERIES_POR_PROVEEDOR[(codProvee ?? '').trim()] ?? null
}
