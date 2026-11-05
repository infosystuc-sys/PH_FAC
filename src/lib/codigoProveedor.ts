/**
 * Proveedores que imprimen en el comprobante un código de artículo más
 * largo que el sinónimo con el que Tango los tiene cargados (`CPA15`), y
 * cuántos caracteres del principio del código impreso son el sinónimo.
 *
 * IMPORTADORA MEDITERRANEA SA (IMSA, `010337`, CUIT 30-64202042-7):
 * decisión del usuario, 2026-11-04. Sus remitos y facturas de motos
 * imprimen el código del modelo con más datos pegados, y el sinónimo
 * cargado en Tango son los 8 primeros caracteres (`MNTD-150` = `105164`).
 *
 * Se aplica en las dos direcciones, en `src/server/tango/articulos.ts`: al
 * buscar el artículo de un código impreso y al enseñar un sinónimo nuevo.
 * Si solo se recortara al buscar, el sinónimo que enseña el operador se
 * guardaría con el código entero y nunca más volvería a encontrarse.
 */
export const LARGO_SINONIMO_POR_PROVEEDOR: Readonly<Record<string, number>> = {
  '010337': 8,
}

/**
 * La parte del código impreso que se busca como sinónimo en Tango. Para
 * los proveedores sin regla es el código entero. Los caracteres se cuentan
 * tal como vienen impresos, guiones incluidos.
 */
export function codigoParaSinonimo(codProvee: string | null | undefined, codigo: string): string {
  const c = codigo.trim()
  const largo = LARGO_SINONIMO_POR_PROVEEDOR[(codProvee ?? '').trim()]
  return largo ? c.slice(0, largo).trim() : c
}
