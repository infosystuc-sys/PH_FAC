/**
 * Qué órdenes de compra del proveedor tienen que ver con ESTA factura.
 *
 * El selector de OC ofrecía todas las del proveedor con saldo pendiente, y
 * el operador tenía que reconocer a ojo cuál era. Desde el 2026-09-07
 * (decisión del usuario) se ofrecen solo las que contienen los artículos
 * que la factura cobra, emparejando el código impreso contra
 * `CPA15.COD_SINONI`.
 *
 * La traducción se recibe ya resuelta, igual que en `cotejoOc.ts`: así esto
 * es lógica pura y se prueba sin base.
 */
import { normalizarCodigo } from './cotejoOc'

export type OcParaMatch = {
  nOrdenCo: string
  renglones: { codArticu: string }[]
}

export type OcEmparejada<T> = {
  oc: T
  /** Los códigos NUESTROS de esta OC que la factura cobra. */
  articulos: string[]
}

export type Emparejamiento<T> = {
  /** Las que contienen al menos un artículo de la factura, la que más primero. */
  coinciden: OcEmparejada<T>[]
  /**
   * Los códigos impresos que no se pudieron llevar a ningún artículo: ni son
   * un código nuestro ni hay sinónimo cargado para ellos. Son los que el
   * operador puede enseñar.
   */
  sinResolver: string[]
}

/**
 * Basta UN artículo en común para que una OC entre. No se exige que estén
 * todos a propósito: facturar una OC en varias veces es normal, y una misma
 * factura puede repartirse entre dos órdenes -- verificado contra la base,
 * hay 64 facturas vinculadas a dos OC. Exigiendo el total, una factura
 * partida no encontraría ninguna.
 *
 * El orden es por cantidad de artículos en común, de mayor a menor. Entre
 * las que empatan se conserva el orden en que vinieron, que es por fecha de
 * emisión descendente.
 */
export function emparejarOcs<T extends OcParaMatch>(
  codigosPdf: (string | null | undefined)[],
  ocs: T[],
  sinonimos: Map<string, string>,
): Emparejamiento<T> {
  const codigos = codigosPdf.map((c) => normalizarCodigo(c ?? '')).filter((c) => c !== '')
  if (codigos.length === 0) return { coinciden: [], sinResolver: [] }

  // Todos los artículos que las OC de este proveedor tienen pendientes. Un
  // código impreso que ya sea uno de estos no necesita traducción: hay
  // proveedores que facturan con nuestro propio código.
  const nuestros = new Set<string>()
  for (const oc of ocs) for (const r of oc.renglones) nuestros.add(normalizarCodigo(r.codArticu))

  const resueltos = new Set<string>()
  const sinResolver: string[] = []
  for (const codigo of codigos) {
    // Primero tal cual y después traducido, mismo orden que `cotejarConOc`:
    // si un proveedor usa como sinónimo un código que también es nuestro,
    // gana el nuestro.
    const nuestro = nuestros.has(codigo) ? codigo : normalizarCodigo(sinonimos.get(codigo) ?? '')
    if (nuestro && nuestros.has(nuestro)) resueltos.add(nuestro)
    else if (!sinResolver.includes(codigo)) sinResolver.push(codigo)
  }

  const coinciden: OcEmparejada<T>[] = []
  for (const oc of ocs) {
    const articulos = oc.renglones
      .map((r) => normalizarCodigo(r.codArticu))
      .filter((a) => resueltos.has(a))
    if (articulos.length > 0) coinciden.push({ oc, articulos: [...new Set(articulos)] })
  }
  coinciden.sort((a, b) => b.articulos.length - a.articulos.length)

  return { coinciden, sinResolver }
}
