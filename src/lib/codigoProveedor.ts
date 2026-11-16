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

/**
 * Proveedores con un largo de RESPALDO: primero se busca el código impreso
 * entero y, si no aparece, se comparan los primeros N caracteres contra los
 * primeros N de los sinónimos que el proveedor tiene cargados en `CPA15`.
 *
 * NEWSAN (`010003`): decisión del usuario, 2026-11-16. Imprime las
 * cubiertas con el color pegado al modelo (`CUBQU110BASEROJO`) y en Tango
 * las dos son el mismo artículo (105440, sinónimo `CUBQU110BASE…`). Pero
 * Newsan también vende aires, con códigos como `AS-12UW4RLRCD02 N` que
 * tienen sinónimo propio cargado entero: por eso el entero va primero, y
 * el respaldo solo empareja si los N caracteres llevan a UN solo artículo.
 * Dos modelos que compartan el principio no se confunden: el renglón queda
 * para que lo vincule el operador.
 *
 * A diferencia de `LARGO_SINONIMO_POR_PROVEEDOR`, al enseñar un sinónimo se
 * guarda el código entero (hasta los 15 de `CPA15.COD_SINONI`): como la
 * comparación de respaldo recorta también lo guardado, `CUBQU110BASEROJ`
 * encuentra igual a `CUBQU110BASEAZUL`.
 *
 * Lo que sigue a los N caracteres es el color, y se propone como
 * descripción adicional 2 de cada número de serie del remito (`STA06.DESC2`;
 * ver `restoDelCodigo`).
 */
export const LARGO_RESPALDO_POR_PROVEEDOR: Readonly<Record<string, number>> = {
  '010003': 12,
}

/**
 * Los primeros N caracteres con los que se busca de respaldo, o `null` si
 * el proveedor no tiene regla o el código no es más largo que N (en ese
 * caso el principio es el código entero, que ya se buscó).
 */
export function prefijoDeRespaldo(codProvee: string | null | undefined, codigo: string): string | null {
  const c = codigo.trim()
  const largo = LARGO_RESPALDO_POR_PROVEEDOR[(codProvee ?? '').trim()]
  if (!largo || c.length <= largo) return null
  return c.slice(0, largo).trim()
}

/** Lo que sigue a los N caracteres del respaldo (el color), o '' si no hay. */
export function restoDelCodigo(codProvee: string | null | undefined, codigo: string): string {
  const largo = LARGO_RESPALDO_POR_PROVEEDOR[(codProvee ?? '').trim()]
  return largo ? codigo.trim().slice(largo).trim() : ''
}
