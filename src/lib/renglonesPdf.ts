/**
 * Un renglón tal como lo lee la IA del PDF de una factura de artículos:
 * solo el código del artículo y la cantidad, los dos como texto sin
 * interpretar.
 *
 * Existe para cotejar la factura contra la orden de compra imputada
 * (decisión del usuario, 2026-09-06): la OC dice qué se pidió y cuánto
 * queda por facturar, y esto dice qué está cobrando el papel. Lo que se
 * graba en Tango sale de la OC, no de acá -- estos renglones nunca se
 * escriben en `CPA46`.
 *
 * Son dos datos y no cinco por una razón medida, no por gusto: el JSON
 * Schema de structured outputs tiene un techo de tamaño, y con los 32
 * campos de cabecera de una factura de artículos entra un array de dos o
 * tres datos por ítem, pero no el de cinco que usa el circuito de remito
 * (`CLAVES_RENGLON`). Medido contra la API el 2026-09-06.
 */
export type RenglonPdf = {
  codigo: string | null
  cantidad: string | null
}

export const CLAVES_RENGLON_PDF = ['codigo', 'cantidad'] as const
