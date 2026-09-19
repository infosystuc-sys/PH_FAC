import { parsearImporteONulo } from './formato'

/**
 * Resuelve, renglón por renglón, cuánto cobra de verdad la factura.
 *
 * El problema que resuelve (pedido del usuario, 2026-09-15): hay
 * proveedores que imprimen en el renglón el precio de lista y aplican un
 * descuento global al pie, mientras que en la orden de compra el precio ya
 * está cargado neto. Para comparar contra la OC y para grabar en Tango hace
 * falta el precio NETO de cada renglón, y ese no está impreso en ningún
 * lado: hay que derivarlo.
 *
 * **Los importes que valen son los de la factura.** Hay dos formas de
 * imprimir el descuento, y se distinguen por aritmética, no por el rótulo:
 *
 * - **Subtotales ya netos.** La suma de los subtotales impresos ES la base
 *   gravada. El descuento (si figura al pie) es informativo: ya está dentro
 *   de cada subtotal. El precio neto es subtotal ÷ cantidad.
 * - **Subtotales brutos.** La base gravada es la suma de los subtotales
 *   MENOS el descuento del pie. El precio neto es el subtotal prorrateado,
 *   y el residuo de redondeo va al último renglón para que la suma cierre
 *   al centavo.
 *
 * **Cómo se decide: con el IVA, no con el rótulo "Neto Gravado".** Las dos
 * formas pueden imprimir el mismo número bajo ese rótulo. Caso real:
 * ZOZZOLI (Maxiking), A-00059-00023095, imprime "Importe Neto Gravado
 * 1.106.082,67" -- que es la suma de los subtotales-- y debajo "Descuento
 * General 107.843,06". Leído por el rótulo parece el primer caso; pero el
 * IVA impreso es 209.630,32 = 21% de 998.239,61 = 1.106.082,67 − 107.843,06,
 * y la percepción del 2,5% también se calcula sobre 998.239,61. Es el
 * segundo caso, y el "neto gravado" impreso es el de ANTES del descuento.
 * La primera versión de esta función decidía por el rótulo y se equivocó
 * justo con esa factura; el usuario lo vio en el total imputado.
 *
 * Por eso recibe `baseSegunImpuestos`: la base que implica el IVA impreso
 * (`netoQueImplicaElIva`), que no depende de cómo el proveedor rotule las
 * cosas. Es la evidencia que manda. Sin IVA (una factura exenta, o un
 * comprobante todavía sin alícuotas) se cae al neto de la revisión, que es
 * lo único que queda.
 *
 * Si no cierra de ninguna de las dos formas, no se adivina: la función lo
 * dice y el registro se bloquea (decisión del usuario). Lo mismo si a algún
 * renglón le falta la cantidad, el precio o el subtotal: se bloquea y se
 * pide reprocesar, en vez de dejar que un importe tipeado a mano llegue a
 * Tango sin señal.
 */

export type RenglonImpreso = {
  orden: number
  cantidad: string | null
  precioUnitario: string | null
  subtotal: string | null
}

export type RenglonNeto = {
  orden: number
  cantidad: number
  /** El precio unitario impreso, tal cual. */
  precioImpreso: number
  /** El subtotal impreso, tal cual. */
  subtotalImpreso: number
  /** Lo que la factura cobra de verdad por este renglón. */
  importeNeto: number
  /** importeNeto ÷ cantidad, con 4 decimales -- la precisión de CPA46. */
  precioNeto: number
  /** 1 − precioNeto ÷ precioImpreso, en porcentaje. Informativo. */
  descuentoPorc: number
}

export type CasoDescuento = 'subtotales-netos' | 'subtotales-brutos'

export type ResultadoDescuento =
  | {
      ok: true
      caso: CasoDescuento
      renglones: RenglonNeto[]
      sumaSubtotales: number
      descuentoGeneral: number
      /** La base gravada REAL: lo que suman los importes netos. */
      netoGravado: number
      /** Lo que dice el campo "Neto gravado" de la revisión. */
      netoRevision: number | null
      /**
       * `true` cuando el campo de la revisión no es la base real: típicamente
       * la IA copió el "neto gravado" impreso antes del descuento. Hay que
       * corregirlo -- `corregirNetoTrasDescuento` lo hace solo al leer.
       */
      netoDesactualizado: boolean
      /** Con qué se decidió el caso. */
      evidencia: 'iva' | 'neto-revision'
    }
  | { ok: false; motivo: 'sin-renglones' }
  | { ok: false; motivo: 'sin-neto' }
  | { ok: false; motivo: 'renglon-incompleto'; ordenes: number[] }
  | {
      ok: false
      motivo: 'no-cierra'
      sumaSubtotales: number
      descuentoGeneral: number
      /** La base contra la que se intentó cerrar, y de dónde salió. */
      base: number
      evidencia: 'iva' | 'neto-revision'
    }

/**
 * Tolerancia al comparar contra la base, según de dónde salió la base.
 *
 * Contra el neto de la revisión es un centavo por renglón: lo que puede
 * acumular el redondeo del propio proveedor al imprimir cada subtotal con
 * dos decimales.
 *
 * Contra la base que implica el IVA es más laxa, y a propósito. El IVA
 * está para DECIDIR EL CASO -- subtotales netos o brutos, que difieren en
 * el importe del descuento, miles o millones -- no para cerrar al centavo:
 * cada proveedor redondea el IVA a su manera (por renglón, truncando, sobre
 * el precio sin redondear) y esos centavos de IVA, divididos por la
 * alícuota, son décimas de peso de base. DREAN, 2026-09-19: subtotales
 * 16.905.063,60, IVA impreso 3.550.063,33 → base 16.905.063,48; 12 centavos
 * en 17 millones, y la app bloqueaba. Se admite lo mayor entre un peso y
 * el 0,1% de la base: ningún descuento general es tan chico como para
 * confundirse con eso, y que el neto cierre contra el IVA al centavo lo
 * cuida aparte `validarNetoContraIva`.
 */
function tolerancia(
  cantidadRenglones: number,
  evidencia: 'iva' | 'neto-revision',
  base: number,
): number {
  if (evidencia === 'iva') return Math.max(1, base * 0.001)
  return 0.01 * Math.max(1, cantidadRenglones) + 0.05
}

const a2 = (n: number) => Math.round(n * 100) / 100
const a4 = (n: number) => Math.round(n * 10000) / 10000

export function resolverDescuentoGlobal(
  renglones: RenglonImpreso[],
  descuentoGeneral: string | null | undefined,
  netoRevision: string | null | undefined,
  baseSegunImpuestos: number | null = null,
): ResultadoDescuento {
  if (renglones.length === 0) return { ok: false, motivo: 'sin-renglones' }

  const netoRev = parsearImporteONulo(netoRevision)
  const evidencia: 'iva' | 'neto-revision' =
    baseSegunImpuestos !== null && baseSegunImpuestos > 0 ? 'iva' : 'neto-revision'
  const base = evidencia === 'iva' ? (baseSegunImpuestos as number) : netoRev
  if (base === null || base <= 0) return { ok: false, motivo: 'sin-neto' }

  const leidos = renglones.map((r) => ({
    orden: r.orden,
    cantidad: parsearImporteONulo(r.cantidad),
    precio: parsearImporteONulo(r.precioUnitario),
    subtotal: parsearImporteONulo(r.subtotal),
  }))
  const incompletos = leidos.filter(
    (r) => r.cantidad === null || r.cantidad <= 0 || r.precio === null || r.subtotal === null,
  )
  if (incompletos.length > 0) {
    return { ok: false, motivo: 'renglon-incompleto', ordenes: incompletos.map((r) => r.orden) }
  }

  const suma = a2(leidos.reduce((acc, r) => acc + (r.subtotal as number), 0))
  const descuento = parsearImporteONulo(descuentoGeneral) ?? 0
  const tol = tolerancia(leidos.length, evidencia, base)

  // Con descuento se prueba PRIMERO la lectura "brutos": es la que cambia
  // la base, y si el IVA la confirma no hay ambigüedad posible. Recién si
  // no cierra se prueba la otra.
  let caso: CasoDescuento
  let netoReal: number
  if (descuento > 0 && Math.abs(a2(suma - descuento) - base) <= tol) {
    caso = 'subtotales-brutos'
    netoReal = a2(suma - descuento)
  } else if (Math.abs(suma - base) <= tol) {
    caso = 'subtotales-netos'
    netoReal = suma
  } else {
    return {
      ok: false,
      motivo: 'no-cierra',
      sumaSubtotales: suma,
      descuentoGeneral: descuento,
      base,
      evidencia,
    }
  }

  // Factor que lleva cada subtotal impreso a lo que cobra de verdad. En
  // subtotales netos es 1; en brutos es base ÷ suma, y el residuo de
  // redondeo se carga al último renglón para que la suma cierre exacta.
  const factor = caso === 'subtotales-netos' ? 1 : netoReal / suma
  const salida: RenglonNeto[] = []
  let acumulado = 0
  leidos.forEach((r, i) => {
    const cantidad = r.cantidad as number
    const precioImpreso = r.precio as number
    const subtotalImpreso = r.subtotal as number
    const esUltimo = i === leidos.length - 1
    const importeNeto =
      caso === 'subtotales-netos'
        ? subtotalImpreso
        : esUltimo
          ? a2(netoReal - acumulado)
          : a2(subtotalImpreso * factor)
    acumulado = a2(acumulado + importeNeto)
    const precioNeto = a4(importeNeto / cantidad)
    const descuentoPorc = precioImpreso > 0 ? a4((1 - precioNeto / precioImpreso) * 100) : 0
    salida.push({
      orden: r.orden,
      cantidad,
      precioImpreso,
      subtotalImpreso,
      importeNeto,
      precioNeto,
      descuentoPorc,
    })
  })

  return {
    ok: true,
    caso,
    renglones: salida,
    sumaSubtotales: suma,
    descuentoGeneral: descuento,
    netoGravado: netoReal,
    netoRevision: netoRev,
    // Un peso de tolerancia: separa un neto de cabecera que el proveedor
    // redondeo por su cuenta (DREAN, 2026-09-19: renglon 16.905.063,60 y
    // cabecera 16.905.063,49, con el IVA y el total calculados sobre el ,49)
    // de un neto de ANTES del descuento (ZOZZOLI: 107.843,06 de diferencia).
    // En el primer caso la cabecera se deja como esta: es sobre la que el
    // proveedor liquido el IVA y el total, que es lo que se paga; los
    // renglones van a CPA46 con sus importes exactos igual.
    netoDesactualizado: netoRev === null || Math.abs(netoRev - netoReal) > 1,
    evidencia,
  }
}

const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Para el panel: una línea que explica qué pasó, con los números. */
export function describirDescuento(r: ResultadoDescuento): string {
  if (r.ok) {
    const cierre =
      r.caso === 'subtotales-netos'
        ? `Los subtotales impresos suman la base gravada ($ ${fmt.format(r.netoGravado)})` +
          (r.descuentoGeneral > 0
            ? `: el descuento general de $ ${fmt.format(r.descuentoGeneral)} ya está dentro de cada renglón.`
            : '.')
        : `Los subtotales impresos suman $ ${fmt.format(r.sumaSubtotales)}; menos el descuento general ` +
          `de $ ${fmt.format(r.descuentoGeneral)} dan la base gravada ($ ${fmt.format(r.netoGravado)}). ` +
          `El descuento se prorrateó en cada renglón.`
    const como = r.evidencia === 'iva' ? ' Verificado contra el IVA impreso.' : ''
    const neto = r.netoDesactualizado
      ? ` El neto gravado de la revisión ($ ${r.netoRevision === null ? '—' : fmt.format(r.netoRevision)}) ` +
        `no es la base real: corregilo a $ ${fmt.format(r.netoGravado)}.`
      : ''
    return cierre + como + neto
  }
  if (r.motivo === 'sin-renglones') return 'La factura no tiene renglones leídos.'
  if (r.motivo === 'sin-neto') {
    return 'Falta el neto gravado y no hay IVA impreso: no se puede verificar ningún renglón.'
  }
  if (r.motivo === 'renglon-incompleto') {
    const uno = r.ordenes.length === 1
    return (
      `${uno ? 'El renglón' : 'Los renglones'} ${r.ordenes.join(', ')} no ${uno ? 'tiene' : 'tienen'} ` +
      `cantidad, precio o subtotal legibles. Reprocesá el comprobante.`
    )
  }
  return (
    `Los renglones no cierran contra la base gravada: suman $ ${fmt.format(r.sumaSubtotales)}` +
    (r.descuentoGeneral > 0 ? ` (menos $ ${fmt.format(r.descuentoGeneral)} de descuento general)` : '') +
    ` y la base ${r.evidencia === 'iva' ? 'que implica el IVA impreso' : 'de la revisión'} es ` +
    `$ ${fmt.format(r.base)}.`
  )
}

/** Un renglón del PDF tal como lo guarda `PHF_RENGLON_PDF` (ver detalle.ts). */
export type RenglonPdfParaDescuento = {
  orden: number
  cantidad: string | null
  precioImpreso: string | null
  subtotalImpreso: string | null
}

/**
 * La misma resolución, desde lo guardado. Es la entrada que usan los tres
 * lados -- el panel de validaciones, la tarjeta de renglones y el armado de
 * CPA46 -- para que no puedan discrepar: si la pantalla dijo que cierra,
 * el registro graba exactamente esos importes.
 */
export function resolverDescuentoDeDetalle(
  renglonesPdf: RenglonPdfParaDescuento[],
  descuentoGeneral: string | null | undefined,
  netoRevision: string | null | undefined,
  baseSegunImpuestos: number | null = null,
): ResultadoDescuento {
  return resolverDescuentoGlobal(
    renglonesPdf.map((r) => ({
      orden: r.orden,
      cantidad: r.cantidad,
      precioUnitario: r.precioImpreso,
      subtotal: r.subtotalImpreso,
    })),
    descuentoGeneral,
    netoRevision,
    baseSegunImpuestos,
  )
}

/** Los renglones netos indexados por su orden en el PDF, o vacío si no resolvió. */
export function netosPorOrden(r: ResultadoDescuento): Map<number, RenglonNeto> {
  return new Map(r.ok ? r.renglones.map((x) => [x.orden, x]) : [])
}

/**
 * El neto gravado que corresponde guardar en la revisión, formateado como
 * lo escribe el operador, o `null` si no hay nada que corregir.
 *
 * Es la contraparte de `netoDesactualizado`: cuando la IA copió el "neto
 * gravado" impreso antes del descuento general, la app lo reemplaza por la
 * base real al terminar de leer, en vez de dejarle al operador un número
 * que el IVA contradice. Se aplica solo si resolvió con el IVA como
 * evidencia: sin esa confirmación independiente, pisar lo que leyó la IA
 * sería cambiar un dato por otro igual de dudoso.
 */
export function netoCorregido(r: ResultadoDescuento): string | null {
  if (!r.ok || !r.netoDesactualizado || r.evidencia !== 'iva') return null
  return r.netoGravado.toFixed(2).replace('.', ',')
}
