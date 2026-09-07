/**
 * La fecha con la que el comprobante entra a la contabilidad
 * (`CPA04.FECHA_CONT`), que no siempre es la de emisión.
 *
 * Tango lleva en `CPA10.CIERRE_CON` hasta qué fecha está cerrado el módulo
 * de Compras. Un comprobante que se emitió dentro de ese período cerrado no
 * se puede imputar con su propia fecha: va al primer día del mes siguiente
 * al cierre, que es el primer período abierto. Regla del usuario,
 * 2026-09-07.
 *
 * El caso normal --factura de este mes, cierre del mes pasado-- no cambia
 * nada: la fecha contable es la de emisión.
 */

/** Solo año/mes/día: `CIERRE_CON` es `datetime` y trae hora (ej. 03:53:48). */
function soloFecha(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
}

/** El 1 del mes siguiente al de `d`. Diciembre rueda a enero del año que viene. */
export function primerDiaDelMesSiguiente(d: Date): Date {
  // El constructor de Date normaliza el mes 12 a enero del año siguiente,
  // así que no hace falta tratarlo aparte.
  return new Date(d.getFullYear(), d.getMonth() + 1, 1)
}

/**
 * `cierre` es `CPA10.CIERRE_CON`, o `null` si Tango no tiene cierre cargado.
 *
 * Se compara por día y no por instante: `CIERRE_CON` es `datetime` y en esta
 * base trae hora (el valor "vacío" de Tango es `1800-01-01T03:53:48`), así
 * que comparar los `Date` enteros haría que un cierre del mismo día que la
 * factura cayera de un lado o del otro según la hora.
 *
 * El día del cierre cuenta como cerrado: un comprobante emitido justo ese
 * día también va al mes siguiente. Es la lectura de `CIERRE_CON` como
 * "cerrado hasta acá inclusive", que es como lo usa Tango -- si fuera al
 * revés, una factura del 31/08 con cierre al 31/08 se imputaría dentro de un
 * mes ya cerrado.
 */
export function fechaContableDe(fechaComprobante: Date, cierre: Date | null): Date {
  if (!cierre) return fechaComprobante
  if (soloFecha(cierre) < soloFecha(fechaComprobante)) return fechaComprobante
  return primerDiaDelMesSiguiente(cierre)
}

/** Si la fecha contable terminó siendo distinta de la de emisión. */
export function seCorrioPorCierre(fechaComprobante: Date, cierre: Date | null): boolean {
  return soloFecha(fechaContableDe(fechaComprobante, cierre)) !== soloFecha(fechaComprobante)
}
