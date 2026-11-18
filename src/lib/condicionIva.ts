/**
 * Cómo graba Tango los importes de una factura según la condición de IVA del
 * proveedor (`CPA01.COND_IVA`, que va a `CPA04.CAT_IVA`). Hallazgos N3 y N4
 * del 2026-11-18, decididos por el usuario ese día.
 *
 * Medido sobre todas las facturas cargadas desde Tango en la base de
 * desarrollo (no las de la app):
 *
 * - **Proveedor que no discrimina IVA** (monotributista `RS`/`RSS`, exento
 *   `EX`, consumidor final `CF`) y factura sin IVA: Tango graba TODO como
 *   exento -- `CPA04.IMPORTE_EX`/`SUBT_EXENT`, `CPA47.IMPORTE_EXENTO` y
 *   `CPA46.IMPORTE_EXENTO` -- y nada como gravado. 332 de 333 facturas
 *   `RS`/`RSS` sin IVA, 123 de 123 `EX`/`CF`; 45 de 45 renglones de
 *   artículos y 438 de 440 de conceptos.
 * - **Toda factura con importe exento** lleva una fila de `CPA63` al 0% por
 *   ese importe: 33 de 34 facturas de RI solo exentas, 175 de 191 de RI con
 *   IVA y parte exenta, y todas las de los proveedores de arriba.
 * - La clasificación (`CPA63.CLAS_SIAP`) de esa fila sale de la condición de
 *   IVA: `C9` monotributista (331 de 333), `C7` exento o consumidor final
 *   (123 de 123), `SIN` el resto (174 de 175 en las de RI con IVA).
 *
 * Una factura de monotributista con IVA discriminado (9 en toda la base,
 * letras A y M) no se reclasifica: se graba como viene.
 *
 * Los valores que el operador ve y corrige (`neto`, `exento`) no cambian: la
 * reclasificación se aplica al grabar y en la vista previa del asiento, con
 * esta misma función, para que las dos coincidan.
 */

/** La clasificación de la fila exenta de `CPA63`, por condición que no discrimina IVA. */
const CLASIFICACION_SIN_IVA: Record<string, string> = {
  RS: 'C9',
  RSS: 'C9',
  EX: 'C7',
  CF: 'C7',
}

function normalizar(condIva: string | null | undefined): string {
  return (condIva ?? '').trim().toUpperCase()
}

/** El proveedor no discrimina IVA: lo que factura sin IVA es todo exento. */
export function condicionSinIva(condIva: string | null | undefined): boolean {
  return normalizar(condIva) in CLASIFICACION_SIN_IVA
}

/** `CPA63.CLAS_SIAP` de la fila al 0% que lleva el importe exento. */
export function clasificacionSiapDelExento(condIva: string | null | undefined): string {
  return CLASIFICACION_SIN_IVA[normalizar(condIva)] ?? 'SIN'
}

export type ImportesParaTango = {
  /** Lo que va como gravado (`IMPORTE_NE`, `IMPORTE_GRAVADO`). */
  neto: number
  /** Lo que va como exento (`IMPORTE_EX`, `IMPORTE_EXENTO`). */
  exento: number
  /** El neto leído pasó a exento: los renglones de artículos van exentos. */
  todoExento: boolean
}

/**
 * El gravado y el exento con los que se graba la factura. `hayIva` es si
 * alguna alícuota registra importe: con IVA discriminado no se reclasifica.
 */
export function importesSegunCondicionIva(
  condIva: string | null | undefined,
  neto: number,
  exento: number,
  hayIva: boolean,
): ImportesParaTango {
  if (!hayIva && condicionSinIva(condIva) && neto > 0) {
    return { neto: 0, exento: Math.round((neto + exento) * 100) / 100, todoExento: true }
  }
  return { neto, exento, todoExento: false }
}
