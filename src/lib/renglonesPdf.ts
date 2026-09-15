/**
 * Un renglón tal como lo lee la IA del PDF de una factura de artículos:
 * código, cantidad, precio unitario y subtotal, los cuatro como texto sin
 * interpretar, tal como están impresos.
 *
 * Nació con dos datos (código y cantidad) para cotejar contra la orden de
 * compra (decisión del usuario, 2026-09-06): la OC decía qué se pidió y el
 * precio salía de ahí. El 2026-09-15 el usuario dio vuelta la fuente de
 * verdad: **los importes que valen son los de la factura**. Hay proveedores
 * que imprimen el precio de lista en el renglón y aplican un descuento
 * global al pie, mientras la OC ya tiene el precio neto; para comparar y
 * para grabar hace falta leer lo que la factura cobra por renglón. Ver
 * `descuentoGlobal.ts`.
 *
 * Son cuatro datos y no cinco (no se pide la descripción) por una razón
 * medida: el JSON Schema de structured outputs tiene un techo de tamaño, y
 * con cuatro datos por ítem el array entra con 31 campos de cabecera y no
 * con 32 (medido contra la API el 2026-09-15). Para hacerle lugar, artículos
 * dejó de pedir el 5º slot de IVA -- ver CAMPOS_NO_ANALIZADOS.
 */
export type RenglonPdf = {
  codigo: string | null
  cantidad: string | null
  /** El precio unitario tal como está impreso. Puede ser el de lista, bruto. */
  precioUnitario: string | null
  /** El subtotal del renglón tal como está impreso. */
  subtotal: string | null
}

export const CLAVES_RENGLON_PDF = ['codigo', 'cantidad', 'precioUnitario', 'subtotal'] as const
