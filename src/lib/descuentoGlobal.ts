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
 * **Los importes que valen son los de la factura**, y la referencia contra
 * la que todo tiene que cerrar es el neto gravado de la cabecera. Hay dos
 * formas de imprimir el descuento, y se distinguen por aritmética, no por
 * el rótulo:
 *
 * - **Subtotales ya netos.** La suma de los subtotales impresos da el neto
 *   gravado. El descuento (si figura al pie) es informativo: ya está dentro
 *   de cada subtotal. Caso real: ZOZZOLI (Maxiking), factura A-00059-00023095,
 *   con dos descuentos encadenados -- 13,83% de renglón que no se imprime y
 *   8,88% "Descuento General" -- y P.Unit. bruto (9.500 impreso, 7.458,68
 *   neto). El precio neto es subtotal ÷ cantidad.
 * - **Subtotales brutos.** La suma de los subtotales menos el descuento del
 *   pie da el neto gravado. El precio neto es el subtotal prorrateado por
 *   neto ÷ suma, y el residuo de redondeo va al último renglón para que la
 *   suma de los importes netos cierre al centavo contra el neto.
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
      netoGravado: number
    }
  | { ok: false; motivo: 'sin-renglones' }
  | { ok: false; motivo: 'sin-neto' }
  | { ok: false; motivo: 'renglon-incompleto'; ordenes: number[] }
  | {
      ok: false
      motivo: 'no-cierra'
      sumaSubtotales: number
      descuentoGeneral: number
      netoGravado: number
    }

/**
 * Tolerancia al comparar contra el neto gravado: un centavo por renglón,
 * que es lo que puede acumular el redondeo del propio proveedor al imprimir
 * cada subtotal con dos decimales. Contra un neto de seis cifras es una
 * tolerancia de milésimas de por ciento.
 */
function tolerancia(cantidadRenglones: number): number {
  return 0.01 * Math.max(1, cantidadRenglones) + 0.005
}

const a2 = (n: number) => Math.round(n * 100) / 100
const a4 = (n: number) => Math.round(n * 10000) / 10000

export function resolverDescuentoGlobal(
  renglones: RenglonImpreso[],
  descuentoGeneral: string | null | undefined,
  netoGravado: string | null | undefined,
): ResultadoDescuento {
  if (renglones.length === 0) return { ok: false, motivo: 'sin-renglones' }

  const neto = parsearImporteONulo(netoGravado)
  if (neto === null || neto <= 0) return { ok: false, motivo: 'sin-neto' }

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
  const tol = tolerancia(leidos.length)

  let caso: CasoDescuento
  if (Math.abs(suma - neto) <= tol) {
    caso = 'subtotales-netos'
  } else if (descuento > 0 && Math.abs(suma - descuento - neto) <= tol) {
    caso = 'subtotales-brutos'
  } else {
    return {
      ok: false,
      motivo: 'no-cierra',
      sumaSubtotales: suma,
      descuentoGeneral: descuento,
      netoGravado: neto,
    }
  }

  // Factor que lleva cada subtotal impreso a lo que cobra de verdad. En
  // subtotales netos es 1; en brutos es neto ÷ suma, y el residuo de
  // redondeo se carga al último renglón para que la suma cierre exacta.
  const factor = caso === 'subtotales-netos' ? 1 : neto / suma
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
          ? a2(neto - acumulado)
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
    netoGravado: neto,
  }
}

/** Para el panel: una línea que explica qué pasó, con los números. */
export function describirDescuento(r: ResultadoDescuento): string {
  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (r.ok) {
    if (r.caso === 'subtotales-netos') {
      return (
        `Los subtotales impresos suman el neto gravado ($ ${fmt.format(r.netoGravado)})` +
        (r.descuentoGeneral > 0
          ? `: el descuento general de $ ${fmt.format(r.descuentoGeneral)} ya está dentro de cada renglón.`
          : '.')
      )
    }
    return (
      `Los subtotales impresos suman $ ${fmt.format(r.sumaSubtotales)}; menos el descuento general ` +
      `de $ ${fmt.format(r.descuentoGeneral)} dan el neto gravado ($ ${fmt.format(r.netoGravado)}). ` +
      `El descuento se prorrateó en cada renglón.`
    )
  }
  if (r.motivo === 'sin-renglones') return 'La factura no tiene renglones leídos.'
  if (r.motivo === 'sin-neto') {
    return 'Falta el neto gravado: sin él no se puede verificar ningún renglón.'
  }
  if (r.motivo === 'renglon-incompleto') {
    const uno = r.ordenes.length === 1
    return (
      `${uno ? 'El renglón' : 'Los renglones'} ${r.ordenes.join(', ')} no ${uno ? 'tiene' : 'tienen'} ` +
      `cantidad, precio o subtotal legibles. Reprocesá el comprobante.`
    )
  }
  return (
    `Los renglones no cierran contra el neto gravado: suman $ ${fmt.format(r.sumaSubtotales)}` +
    (r.descuentoGeneral > 0 ? ` (menos $ ${fmt.format(r.descuentoGeneral)} de descuento general)` : '') +
    ` y el neto es $ ${fmt.format(r.netoGravado)}.`
  )
}
