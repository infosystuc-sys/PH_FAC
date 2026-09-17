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
 * La descripción se sumó el 2026-09-17 (pedido del usuario): hay
 * proveedores que no imprimen código de artículo, y lo único estable de un
 * renglón a otro es cómo describen la mercadería. Con ella el operador
 * vincula el renglón a un artículo de Tango una vez y las facturas
 * siguientes emparejan solas (PHF_ARTICULO_PROVEEDOR).
 *
 * Son cinco datos por ítem con 31 campos de cabecera: medido contra la API
 * ese mismo día, entra. Con 32 campos no entraban ni cuatro (medido el
 * 2026-09-15): para hacerle lugar, artículos dejó de pedir el 5º slot de
 * IVA -- ver CAMPOS_NO_ANALIZADOS.
 */
export type RenglonPdf = {
  codigo: string | null
  /** La descripción del artículo tal como está impresa. */
  descripcion: string | null
  cantidad: string | null
  /** El precio unitario tal como está impreso. Puede ser el de lista, bruto. */
  precioUnitario: string | null
  /** El subtotal del renglón tal como está impreso. */
  subtotal: string | null
}

export const CLAVES_RENGLON_PDF = ['codigo', 'descripcion', 'cantidad', 'precioUnitario', 'subtotal'] as const
