import { parsearImporte } from './formato'

/**
 * Coteja lo que cobra la factura (leído del PDF) contra la orden de compra
 * imputada.
 *
 * Es la contraparte de `cotejo.ts`, que hacía lo mismo contra el remito.
 * Cambia el criterio además de la fuente: contra el remito una diferencia
 * mandaba el comprobante a observación, y contra la OC BLOQUEA el registro
 * -- decisión del usuario, 2026-09-06. La razón es que la OC es un
 * compromiso previo: si la factura cobra algo que no se pidió, o más de lo
 * que queda por facturar, eso no se resuelve revisando el papel de nuevo.
 */

/** Lo que la factura cobra, tal como lo leyó la IA del PDF. */
export type LineaPdf = {
  orden: number
  codigo: string | null
  cantidad: string | null
}

/** Lo que la OC tiene disponible, ya imputado al comprobante. */
export type LineaOc = {
  nRenglOc: number
  codArticu: string
  descripcion: string
  pendiente: number
}

export type ProblemaCotejo =
  | { tipo: 'sin-codigo'; orden: number }
  | { tipo: 'no-esta-en-la-oc'; orden: number; codigo: string }
  | { tipo: 'excede-pendiente'; orden: number; codigo: string; factura: number; pendiente: number }

export type ResultadoCotejoOc = {
  problemas: ProblemaCotejo[]
  /** Renglones de la OC que la factura no menciona. No es un problema:
   *  facturar parte de una OC es lo normal. Se informa, nada más. */
  noFacturados: LineaOc[]
}

/**
 * Tolerancia al comparar cantidades. Las de la factura salen de parsear
 * texto de un PDF y las de la OC son DECIMAL(19,4): comparar con `===`
 * marcaría en rojo una diferencia de redondeo que no existe. Misma
 * precisión que usa `cotejarRenglones` contra el remito.
 */
const TOLERANCIA = 0.00005

/**
 * `sinonimos` mapea el código con el que el proveedor llama al artículo
 * (`CPA15.COD_SINONI`) al nuestro. Se recibe ya resuelto en vez de
 * consultarlo acá para que esta función sea pura y testeable sin base --
 * mismo criterio que `resolverAlicuotas` con lo aprendido.
 */
export function cotejarConOc(
  pdf: LineaPdf[],
  oc: LineaOc[],
  sinonimos: Map<string, string> = new Map(),
): ResultadoCotejoOc {
  const problemas: ProblemaCotejo[] = []
  const mencionados = new Set<string>()

  const porCodigo = new Map(oc.map((l) => [l.codArticu.trim(), l]))

  for (const linea of pdf) {
    const crudo = (linea.codigo ?? '').trim()
    if (!crudo) {
      // Sin código no hay contra qué cotejar. Bloquea igual: una línea que
      // la factura cobra y no se puede identificar es exactamente el caso
      // que no hay que dejar pasar a Tango.
      problemas.push({ tipo: 'sin-codigo', orden: linea.orden })
      continue
    }

    // El código puede venir en el nuestro o en el del proveedor. Se prueba
    // primero tal cual y después traducido, en ese orden: si un proveedor
    // usa como sinónimo un código que también es nuestro, gana el nuestro.
    const nuestro = porCodigo.has(crudo) ? crudo : (sinonimos.get(crudo) ?? crudo)
    const enOc = porCodigo.get(nuestro)

    if (!enOc) {
      problemas.push({ tipo: 'no-esta-en-la-oc', orden: linea.orden, codigo: crudo })
      continue
    }
    mencionados.add(enOc.codArticu.trim())

    const cantidad = parsearImporte(linea.cantidad)
    if (cantidad - enOc.pendiente > TOLERANCIA) {
      problemas.push({
        tipo: 'excede-pendiente',
        orden: linea.orden,
        codigo: crudo,
        factura: cantidad,
        pendiente: enOc.pendiente,
      })
    }
  }

  return {
    problemas,
    noFacturados: oc.filter((l) => !mencionados.has(l.codArticu.trim())),
  }
}

/** El cotejo en una línea, para el panel de "Listo para registrar". */
export function describirCotejo(r: ResultadoCotejoOc): string {
  const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 })
  return r.problemas
    .map((p) => {
      if (p.tipo === 'sin-codigo') return `renglón ${p.orden} sin código de artículo`
      if (p.tipo === 'no-esta-en-la-oc') return `"${p.codigo}" no está en la orden de compra`
      return (
        `"${p.codigo}" factura ${fmt.format(p.factura)} y la orden tiene ` +
        `${fmt.format(p.pendiente)} pendiente(s)`
      )
    })
    .join('; ')
}
