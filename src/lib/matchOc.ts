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

/**
 * Lleva un código impreso por el proveedor a un artículo nuestro.
 *
 * `nuestros` son los códigos candidatos --los de las OC que se estén
 * mirando-- y se prueba primero contra ellos tal cual, antes de traducir:
 * si un proveedor usa como sinónimo un código que también es nuestro, gana
 * el nuestro. Mismo orden que `cotejarConOc`.
 *
 * Devuelve el código NUESTRO ya normalizado, o `null` si no se pudo
 * resolver: ni es uno de los candidatos ni hay sinónimo cargado que lleve a
 * uno.
 */
export function resolverCodigoArticulo(
  impreso: string | null | undefined,
  nuestros: Set<string>,
  sinonimos: Map<string, string>,
): string | null {
  const clave = normalizarCodigo(impreso ?? '')
  if (clave === '') return null
  if (nuestros.has(clave)) return clave

  const traducido = normalizarCodigo(sinonimos.get(clave) ?? '')
  return traducido && nuestros.has(traducido) ? traducido : null
}

/** Lo que la factura cobra en un renglón, tal como lo leyó la IA del PDF. */
export type LineaFactura = {
  orden: number
  codigo: string | null
  cantidad: string | null
}

export type RenglonEmparejado<T> = {
  linea: LineaFactura
  /** El renglón de la OC que le corresponde, o `null` si esta OC no lo tiene. */
  enOc: T | null
}

/**
 * Qué renglón de la OC le corresponde a cada renglón de la factura.
 *
 * Es lo que decide qué se trae al imputar: desde el 2026-09-07 el detalle
 * del comprobante son los artículos que la FACTURA cobra --resueltos contra
 * la OC-- y no todos los renglones pendientes de la orden. Traerlos todos
 * obligaba al operador a borrar a mano los que la factura no cobraba;
 * quedó a la vista con una factura de CARRIER que cobra un solo artículo
 * contra una OC de nueve.
 */
export function emparejarRenglones<T extends { codArticu: string }>(
  pdf: LineaFactura[],
  renglonesOc: T[],
  sinonimos: Map<string, string>,
): RenglonEmparejado<T>[] {
  const porCodigo = new Map(renglonesOc.map((r) => [normalizarCodigo(r.codArticu), r]))
  const nuestros = new Set(porCodigo.keys())

  return pdf.map((linea) => {
    const nuestro = resolverCodigoArticulo(linea.codigo, nuestros, sinonimos)
    return { linea, enOc: nuestro ? (porCodigo.get(nuestro) ?? null) : null }
  })
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
  /**
   * Los códigos impresos que SÍ se reconocen -- hay sinónimo cargado en
   * CPA15 -- pero cuyo artículo no tiene pendiente de facturar en ninguna
   * orden del proveedor. No es lo mismo que `sinResolver`, y hasta el
   * 2026-09-15 iban juntos: la pantalla decía "este código no se reconoce" y
   * ofrecía enseñar un sinónimo que ya existía. Lo reportó el usuario con
   * ZOZZOLI (12100 → 101406, 37 renglones de OC, ninguno con pendiente).
   * Enseñar no arregla nada acá: lo que falta es una orden con saldo.
   */
  reconocidosSinPendiente: { codigo: string; codArticu: string }[]
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
  if (codigos.length === 0) return { coinciden: [], sinResolver: [], reconocidosSinPendiente: [] }

  // Todos los artículos que las OC de este proveedor tienen pendientes. Un
  // código impreso que ya sea uno de estos no necesita traducción: hay
  // proveedores que facturan con nuestro propio código.
  const nuestros = new Set<string>()
  for (const oc of ocs) for (const r of oc.renglones) nuestros.add(normalizarCodigo(r.codArticu))

  const resueltos = new Set<string>()
  const sinResolver: string[] = []
  const reconocidosSinPendiente: { codigo: string; codArticu: string }[] = []
  for (const codigo of codigos) {
    const nuestro = resolverCodigoArticulo(codigo, nuestros, sinonimos)
    if (nuestro) {
      resueltos.add(nuestro)
      continue
    }
    // Se distingue "no hay sinonimo" de "hay sinonimo pero el articulo no
    // tiene saldo": la primera se arregla enseñando, la segunda no.
    const traducido = normalizarCodigo(sinonimos.get(codigo) ?? '')
    if (traducido) {
      if (!reconocidosSinPendiente.some((r) => r.codigo === codigo)) {
        reconocidosSinPendiente.push({ codigo, codArticu: traducido })
      }
    } else if (!sinResolver.includes(codigo)) {
      sinResolver.push(codigo)
    }
  }

  const coinciden: OcEmparejada<T>[] = []
  for (const oc of ocs) {
    const articulos = oc.renglones
      .map((r) => normalizarCodigo(r.codArticu))
      .filter((a) => resueltos.has(a))
    if (articulos.length > 0) coinciden.push({ oc, articulos: [...new Set(articulos)] })
  }
  coinciden.sort((a, b) => b.articulos.length - a.articulos.length)

  return { coinciden, sinResolver, reconocidosSinPendiente }
}
