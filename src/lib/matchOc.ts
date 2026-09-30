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
import { parsearImporte } from './formato'
import {
  parsearDesgloseTalles,
  totalDesglosado,
  describirTalle,
  articulosPorTalle,
} from './talles'

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

export type RenglonEmparejado<T, L extends LineaFactura = LineaFactura> = {
  linea: L
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
export function emparejarRenglones<T extends { codArticu: string }, L extends LineaFactura>(
  pdf: L[],
  renglonesOc: T[],
  sinonimos: Map<string, string>,
): RenglonEmparejado<T, L>[] {
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
  // Se conserva el codigo impreso al lado de su clave: lo que se informa al
  // operador es lo impreso ("NO-EXISTE"), no la clave ("NOEXISTE"), que
  // desde que ignora la puntuacion ya no se parece a lo que ve en el papel.
  const codigos = codigosPdf
    .map((c) => ({ impreso: (c ?? '').trim(), clave: normalizarCodigo(c ?? '') }))
    .filter((c) => c.clave !== '')
  if (codigos.length === 0) return { coinciden: [], sinResolver: [], reconocidosSinPendiente: [] }

  // Todos los artículos que las OC de este proveedor tienen pendientes. Un
  // código impreso que ya sea uno de estos no necesita traducción: hay
  // proveedores que facturan con nuestro propio código.
  const nuestros = new Set<string>()
  for (const oc of ocs) for (const r of oc.renglones) nuestros.add(normalizarCodigo(r.codArticu))

  const resueltos = new Set<string>()
  const sinResolver: string[] = []
  const reconocidosSinPendiente: { codigo: string; codArticu: string }[] = []
  const vistos = new Set<string>()
  for (const { impreso, clave } of codigos) {
    const nuestro = resolverCodigoArticulo(clave, nuestros, sinonimos)
    if (nuestro) {
      resueltos.add(nuestro)
      continue
    }
    // Un mismo codigo repetido en la factura se informa una sola vez.
    if (vistos.has(clave)) continue
    vistos.add(clave)
    // Se distingue "no hay sinonimo" de "hay sinonimo pero el articulo no
    // tiene saldo": la primera se arregla enseñando, la segunda no.
    const traducido = normalizarCodigo(sinonimos.get(clave) ?? '')
    if (traducido) reconocidosSinPendiente.push({ codigo: impreso, codArticu: traducido })
    else sinResolver.push(impreso)
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

/**
 * Cómo se compara la descripción impresa de un artículo: sin acentos, en
 * minúsculas, con los espacios colapsados. Es la clave de
 * `PHF_ARTICULO_PROVEEDOR` -- se guarda y se busca con esta misma función,
 * si divergieran una fila aprendida nunca haría match.
 */
export function normalizarDescripcionArticulo(texto: string | null | undefined): string {
  return (texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Un renglón del PDF con lo que hace falta para resolverle el artículo. */
export type LineaPdfParaResolver = {
  orden: number
  codigo: string | null
  descripcion: string | null
  cantidad: string | null
}

/** Lo que el operador enseñó para una descripción de este proveedor. */
export type ArticuloAprendido = { codArticu: string; sinOc: boolean }

/** La misma línea, ya con el código con el que se la va a emparejar. */
export type LineaPdfResuelta = LineaPdfParaResolver & {
  /**
   * `true` cuando el código no vino impreso y salió de lo que el operador
   * enseñó para esta descripción (PHF_ARTICULO_PROVEEDOR). Se distingue
   * para mostrarlo: el operador tiene que ver que ese emparejamiento es
   * por descripción, no por código.
   */
  porDescripcion: boolean
  /**
   * `true` cuando el operador marcó esta descripción como CARGO del
   * proveedor: se registra igual --en CPA46 y en el asiento-- pero no va
   * contra ninguna orden de compra. Ver `SIN_OC` en migrate.ts.
   */
  sinOc: boolean
}

/**
 * Le pone a cada renglón el código con el que se lo empareja.
 *
 * Hay proveedores que no imprimen código de artículo (2026-09-17, pedido
 * del usuario): lo único estable de un renglón a otro es la descripción.
 * El operador la vincula una vez a un artículo nuestro y de ahí en más se
 * resuelve sola. La regla es simple y no adivina: si la factura trae
 * código, manda el código (y su sinónimo de CPA15); si no trae, se busca la
 * descripción entre lo aprendido; si tampoco está, el renglón queda sin
 * código y la tarjeta de la OC lo ofrece para vincular.
 *
 * `sinOc` sale siempre de lo aprendido por descripción, tenga la línea
 * código impreso o no: que un renglón sea un cargo del proveedor no depende
 * de si la factura imprimió un código al lado.
 */
export function resolverLineasPdf(
  lineas: LineaPdfParaResolver[],
  porDescripcion: Record<string, ArticuloAprendido>,
): LineaPdfResuelta[] {
  return lineas.map((l) => {
    const aprendido = porDescripcion[normalizarDescripcionArticulo(l.descripcion)]
    const sinOc = aprendido?.sinOc ?? false

    // Un CARGO es la excepción a "si la factura trae código, manda el
    // código": el código que el proveedor le pone a un seguro o a un flete
    // es interno suyo y no existe en nuestro maestro, así que respetarlo
    // deja el renglón apuntando a un artículo inexistente y el registro
    // corta en Tango. DASS factura "280910 SEGURO-FLETES" (2026-09-30).
    // Que el operador lo haya marcado como cargo Y le haya elegido un
    // artículo es una decisión explícita suya, y gana sobre lo impreso --
    // misma precedencia que el resto de la app: corrección del operador
    // antes que lo aprendido, y lo aprendido antes que la regla general.
    if (aprendido && sinOc) {
      return { ...l, codigo: aprendido.codArticu, porDescripcion: true, sinOc }
    }

    if ((l.codigo ?? '').trim() !== '') return { ...l, porDescripcion: false, sinOc }
    return aprendido
      ? { ...l, codigo: aprendido.codArticu, porDescripcion: true, sinOc }
      : { ...l, porDescripcion: false, sinOc }
  })
}

/**
 * Una línea del PDF ya abierta por talle. Cuando la factura no desglosa,
 * es la misma línea con `talle` en `null`.
 */
export type LineaPdfAbierta = LineaPdfResuelta & {
  /** El talle de este renglón, o `null` si la línea no venía desglosada. */
  talle: string | null
  /**
   * Las cantidades de TODOS los talles que salieron de esta línea del PDF,
   * en orden. Es lo que hace falta para repartir el subtotal impreso, que
   * es uno solo para la línea entera. Vacío si no se abrió.
   */
  cantidadesHermanas: number[]
  /** La posición de este talle dentro de `cantidadesHermanas`. */
  indiceTalle: number
}

/**
 * Abre los renglones que la factura desglosa por talle: uno por talle, con
 * el código del artículo de Tango que le corresponde.
 *
 * `candidatos` son los códigos donde buscar el artículo de cada talle --los
 * renglones de la OC que se imputa, o los de todas las órdenes con
 * pendiente del proveedor--. Ver `articulosPorTalle`: el código NO se
 * compone concatenando, se busca entre los que Tango ya tiene.
 *
 * Una línea se deja CERRADA --tal como vino-- en tres casos, y en los tres
 * a propósito: si no trae desglose; si los talles no suman la cantidad
 * impresa; y si algún talle se queda sin artículo. Abrir a medias o con
 * cantidades que no cuadran es peor que no abrir: el operador ve el
 * problema igual --el cotejo contra la OC lo bloquea-- pero sobre los
 * números del papel, que es contra lo que puede revisar.
 */
export function abrirPorTalle(
  lineas: LineaPdfResuelta[],
  candidatos: string[],
): LineaPdfAbierta[] {
  const salida: LineaPdfAbierta[] = []
  for (const linea of lineas) {
    const cerrada: LineaPdfAbierta = {
      ...linea,
      talle: null,
      cantidadesHermanas: [],
      indiceTalle: 0,
    }

    // Un cargo del proveedor no va contra ninguna orden: no hay contra qué
    // resolverle los talles, y tampoco tiene sentido abrirlo.
    if (linea.sinOc) {
      salida.push(cerrada)
      continue
    }

    const talles = parsearDesgloseTalles(linea.descripcion)
    if (talles.length === 0) {
      salida.push(cerrada)
      continue
    }

    // La cantidad impresa manda: si los talles no la suman, el desglose se
    // leyó mal y no se abre nada.
    const impresa = parsearImporte(linea.cantidad)
    if (impresa > 0 && Math.abs(totalDesglosado(talles) - impresa) > 0.00005) {
      salida.push(cerrada)
      continue
    }

    const porTalle = articulosPorTalle(linea.codigo, talles, candidatos)
    if (!porTalle) {
      salida.push(cerrada)
      continue
    }

    const cantidades = talles.map((t) => t.cantidad)
    talles.forEach((t, i) => {
      salida.push({
        ...linea,
        codigo: porTalle.get(t.talle) ?? linea.codigo,
        descripcion: describirTalle(linea.descripcion, t.talle),
        cantidad: String(t.cantidad),
        talle: t.talle,
        cantidadesHermanas: cantidades,
        indiceTalle: i,
      })
    })
  }
  return salida
}

/** Los renglones que siguen sin código después de aplicar lo aprendido. */
export function lineasAVincular(lineas: LineaPdfResuelta[]): LineaPdfResuelta[] {
  return lineas.filter((l) => (l.codigo ?? '').trim() === '')
}

/**
 * Los renglones que van contra una orden de compra: todos menos los cargos.
 * Es lo que se coteja contra la OC y lo que puede consumir su pendiente.
 */
export function lineasContraOc<T extends LineaPdfResuelta>(lineas: T[]): T[] {
  return lineas.filter((l) => !l.sinOc)
}

/** Los cargos: se registran igual, pero sin orden de compra. */
export function lineasCargo<T extends LineaPdfResuelta>(lineas: T[]): T[] {
  return lineas.filter((l) => l.sinOc && (l.codigo ?? '').trim() !== '')
}
