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

/** El largo de `CPA15.COD_SINONI`. */
export const LARGO_COD_SINONI = 15

/**
 * Los primeros 15 caracteres del código impreso, cuando es más largo de lo
 * que entra en `CPA15.COD_SINONI` (2026-11-18, pedido del usuario con NEWSAN
 * `CUBQU110BASEAZUL`: "el código del proveedor en la factura es más largo
 * que el que se puede poner en Tango; limitá la lectura a 15 caracteres").
 * El sinónimo se carga en Tango con esos 15 -- y la app, al enseñarlo, ya lo
 * guarda recortado a 15 --, así que se busca EXACTO, antes de cualquier
 * respaldo por principio. `null` si el código entra entero, o para los
 * proveedores con regla de largo propia (IMSA), que buscan su principio.
 */
export function codigoRecortadoACodSinoni(codProvee: string | null | undefined, codigo: string): string | null {
  const prov = (codProvee ?? '').trim()
  if (LARGO_SINONIMO_POR_PROVEEDOR[prov]) return null
  const c = codigo.trim()
  if (c.length <= LARGO_COD_SINONI) return null
  return c.slice(0, LARGO_COD_SINONI).trim() || null
}

/**
 * Proveedores con regla de largo (`LARGO_SINONIMO_POR_PROVEEDOR`) que, para
 * los artículos con número de serie, buscan PRIMERO el código impreso entero
 * (hasta los 15 de `CPA15.COD_SINONI`) y solo si no aparece, el principio.
 *
 * IMSA (`010337`): decisión del usuario, 2026-11-18. En las motos el
 * principio no alcanza para distinguir el modelo (`MNLD-110PL-AUE2`, la LD
 * 110 MAX pl, y cualquier otra `MNLD-110…` comparten los 8), así que el
 * sinónimo de esos artículos se carga entero en Tango. El entero solo cuenta
 * si lleva a un artículo con serie (`STA11.USA_SERIE`); para los demás sigue
 * valiendo solo el principio, como hasta ahora.
 */
export const PROVEEDORES_ENTERO_CON_SERIE: ReadonlySet<string> = new Set(['010337'])

/**
 * El código impreso entero (hasta 15) que se busca primero para los
 * artículos con serie, o `null` si el proveedor no tiene esa regla o si es
 * lo mismo que ya se busca con `codigoParaSinonimo`.
 */
export function codigoEnteroConSerie(codProvee: string | null | undefined, codigo: string): string | null {
  const prov = (codProvee ?? '').trim()
  if (!PROVEEDORES_ENTERO_CON_SERIE.has(prov)) return null
  const entero = codigo.trim().slice(0, LARGO_COD_SINONI).trim()
  return entero !== '' && entero !== codigoParaSinonimo(prov, codigo) ? entero : null
}

/**
 * El sinónimo que se guarda en `CPA15` al enseñar un código: el entero
 * (hasta 15) si el artículo lleva serie y el proveedor tiene esa regla, para
 * que la búsqueda de arriba lo encuentre; si no, `codigoParaSinonimo`.
 */
export function sinonimoAGuardar(codProvee: string | null | undefined, codigo: string, usaSerie: boolean): string {
  const entero = usaSerie ? codigoEnteroConSerie(codProvee, codigo) : null
  return entero ?? codigoParaSinonimo(codProvee, codigo)
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
 * El respaldo de TODOS los demás proveedores (2026-11-17, decisión del
 * usuario): los 15 caracteres de `CPA15.COD_SINONI`. Un código impreso más
 * largo se guarda recortado a 15 al enseñarlo, así que sin esto la
 * siguiente factura lo buscaba entero y no lo encontraba. No aplica a los
 * proveedores con regla propia (`LARGO_SINONIMO_POR_PROVEEDOR`, IMSA), que
 * ya buscan solo su principio, ni a NEWSAN, que tiene la suya de 12. Solo
 * empareja si los 15 llevan a UN artículo, igual que el de NEWSAN.
 */
export const LARGO_RESPALDO_GENERAL = 15

function largoDeRespaldo(codProvee: string | null | undefined): number | null {
  const prov = (codProvee ?? '').trim()
  if (!prov || LARGO_SINONIMO_POR_PROVEEDOR[prov]) return null
  return LARGO_RESPALDO_POR_PROVEEDOR[prov] ?? LARGO_RESPALDO_GENERAL
}

/**
 * Los primeros N caracteres con los que se busca de respaldo, o `null` si
 * el proveedor no tiene respaldo o el código no es más largo que N (en ese
 * caso el principio es el código entero, que ya se buscó).
 */
export function prefijoDeRespaldo(codProvee: string | null | undefined, codigo: string): string | null {
  const c = codigo.trim()
  const largo = largoDeRespaldo(codProvee)
  if (!largo || c.length <= largo) return null
  return c.slice(0, largo).trim()
}

/** Lo que sigue a los N caracteres del respaldo (el color), o '' si no hay. */
export function restoDelCodigo(codProvee: string | null | undefined, codigo: string): string {
  const largo = LARGO_RESPALDO_POR_PROVEEDOR[(codProvee ?? '').trim()]
  return largo ? codigo.trim().slice(largo).trim() : ''
}
