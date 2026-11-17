/**
 * Proveedores cuyas liquidaciones de tarjeta tienen una regla propia para
 * armar el subtotal (el neto gravado). Se reconocen por el CUIT impreso,
 * no por el código de proveedor: el CUIT de la procesadora no siempre lleva
 * solo a su proveedor en Tango, y la regla tiene que valer desde la primera
 * lectura.
 *
 * Cuando la lectura encuentra uno de estos CUIT, la cola vuelve a leer el
 * comprobante como liquidación de tarjeta --aunque se haya importado como
 * otro tipo-- con la instrucción del proveedor sumada al prompt, y le
 * asigna el proveedor de la regla (ver `procesarUno` en cola.ts).
 */
export type ReglaLiquidacion = {
  /** El CUIT impreso de la procesadora, solo dígitos. */
  cuit: string
  /** El proveedor de Tango al que se imputa. */
  codProvee: string
  nombre: string
  /** Lo que se le agrega al prompt de tarjeta para este proveedor. */
  instruccion: string
}

export const REGLAS_LIQUIDACION: readonly ReglaLiquidacion[] = [
  {
    // CASTILLO S A C I F I A (`010139`), liquidaciones de TARJETA CREDICASH.
    // Decisión del usuario, 2026-11-16: el subtotal son todos los conceptos
    // del recuadro de totales menos los impuestos; no cuentan el importe de
    // ventas ni el neto a pagar. En la liquidación 959223: cargos 403,00 +
    // arancel 28.690,66 + int. pago anticipado 267.779,49 = 296.873,15, que
    // es exactamente lo que implica el IVA 21% impreso (62.343,36).
    cuit: '30529483522',
    codProvee: '010139',
    nombre: 'CASTILLO S A C I F I A (Tarjeta CrediCash)',
    instruccion: `REGLA DE ESTE PROVEEDOR (TARJETA CREDICASH). Tiene prioridad sobre lo
que se dijo arriba sobre los cargos.
El neto gravado es la SUMA DE TODOS LOS CONCEPTOS DEL RECUADRO DE TOTALES
(abajo de la tabla de cupones) QUE NO SEAN IMPUESTOS. Por ejemplo: CARGOS,
CONTRAPARTIDA, ARANCEL, INT.PAGO ANTICIPADO, INT.PAGO RAPIDO 72HS, PUBLIC. Y
PROPAGANDA, LIQUIDACION NEGATIVA, y cualquier otro concepto de ese recuadro
que no sea un impuesto. Devolvé cada uno en "cargos", también los que estén
en 0,00.
NO van al neto ni a "cargos":
- IMPORTE VENTAS (lo vendido) ni NETO A PAGAR (lo que se acredita).
- Los impuestos: IVA 21%, IVA 10,5%, RET. IVA, RET. IMP. A LAS GANANCIAS,
  PERCEP.IVA RES. GRAL. 3337, RET. IMP S/ ING. BRUTOS, RET. RG 116/10,
  REGIMEN DE RET. SIRTAC, IMPUESTO AL DEBITO.
- BONIF. A CLIENTES INCLUIDA EN IMP. VTAS.: ya está dentro del importe de
  ventas.
- El "ARANCEL" del encabezado, al lado de "FORMA DE PAGO": es un
  porcentaje, no un importe. El que suma es el ARANCEL del recuadro de
  totales.
- Los importes de la tabla de cupones.`,
  },
]

/**
 * La regla del proveedor cuyo CUIT impreso es `cuit`, o `null`.
 *
 * Compara los 10 primeros dígitos y no el verificador: en CrediCash el CUIT
 * va en letra muy chica y la misma liquidación se leyó una vez con "-2" y
 * otra con "-3" al final (2026-11-16). Que dos CUIT distintos compartan los
 * 10 primeros dígitos no pasa: el verificador sale de ellos.
 */
export function reglaLiquidacionPorCuit(cuit: string | null | undefined): ReglaLiquidacion | null {
  const digitos = (cuit ?? '').replace(/\D/g, '')
  if (digitos.length !== 11) return null
  return REGLAS_LIQUIDACION.find((r) => r.cuit.slice(0, 10) === digitos.slice(0, 10)) ?? null
}
