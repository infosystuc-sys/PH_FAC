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
 * Cómo se comparan dos códigos de artículo: en mayúsculas y SIN NINGÚN
 * espacio, ni en las puntas ni adentro.
 *
 * `CPA15` y `CPA36` están en `Latin1_General_BIN`, que distingue mayúsculas,
 * y uno de los dos códigos siempre sale de un PDF transcripto por el
 * modelo. Comparar byte a byte dejaría sin emparejar un artículo que sí está
 * cargado, por una diferencia que en el papel no existe.
 *
 * Los espacios interiores se ignoran desde el 2026-09-16, pedido del
 * usuario: C C AGRO factura "RO1274DW MT/1-12" y el sinónimo en Tango es
 * "RO1274DWMT/1-12". No es un caso aislado -- 50 de los 174 sinónimos de
 * CPA15 y 1.642 códigos de STA11 tienen espacios adentro, y el modelo los
 * transcribe como puede. Es seguro: medido ese día, al quitar los espacios
 * no colisiona ningún par de sinónimos del mismo proveedor ni ningún par de
 * códigos del maestro.
 *
 * Desde el 2026-09-18 se ignora además toda la puntuación: NEWSAN factura
 * "AS-12UW4RLRCD02 N" y el sinónimo en Tango es "AS12UW4RLRCD02N". Solo
 * quedan letras y números. Medido ese día sobre toda la base: los códigos
 * de STA11 y los sinónimos de CPA15 usan exactamente cuatro caracteres que
 * no son alfanuméricos -- espacio, punto, guion y barra -- y al quitarlos
 * no colisiona ningún par (0 en 9.442 artículos, 0 en 198 sinónimos). La
 * versión SQL de esta misma clave (`describirArticulos`) reemplaza esos
 * cuatro; si algún día aparece otro carácter en un código, hay que sumarlo
 * ahí también.
 *
 * El resultado es una CLAVE de comparación, no un código: lo que se graba
 * en Tango es siempre el código tal como está en la OC o en el maestro.
 */
export function normalizarCodigo(codigo: string): string {
  return codigo
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    // Y desde el 2026-09-30, los CEROS DE ADELANTE: TOPPER factura "027633
    // 001" y en Tango el artículo es "27633  001 31". Es la misma diferencia
    // de siempre --el papel rellena a un ancho fijo, el maestro no-- y sin
    // esto el código no empareja con nada, ni siquiera para darse cuenta de
    // que es un artículo con escala. Se conserva siempre al menos un
    // carácter, así que un código que sea todo ceros no queda vacío.
    //
    // Medido ese día sobre toda la base antes de aplicarlo: 0 colisiones en
    // 9.587 códigos de STA11 y 0 en 377 sinónimos de CPA15. Solo 6 códigos
    // del maestro empiezan con cero.
    .replace(/^0+(?=.)/, '')
}

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

  const porCodigo = new Map(oc.map((l) => [normalizarCodigo(l.codArticu), l]))

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
    const clave = normalizarCodigo(crudo)
    const nuestro = porCodigo.has(clave)
      ? clave
      : normalizarCodigo(sinonimos.get(clave) ?? crudo)
    const enOc = porCodigo.get(nuestro)

    if (!enOc) {
      problemas.push({ tipo: 'no-esta-en-la-oc', orden: linea.orden, codigo: crudo })
      continue
    }
    mencionados.add(normalizarCodigo(enOc.codArticu))

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
    noFacturados: oc.filter((l) => !mencionados.has(normalizarCodigo(l.codArticu))),
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
