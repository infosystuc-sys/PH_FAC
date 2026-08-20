import { parsearImporte } from './formato'

/**
 * Coteja lo que el proveedor factura contra lo que entregó según el remito.
 *
 * La norma es igualdad estricta: una factura de artículos cubre el remito
 * entero (decisión del usuario, 2026-08-20). Todo renglón del remito tiene
 * que estar facturado, con la misma cantidad, y la factura no puede traer
 * nada que el remito no tenga.
 *
 * El emparejamiento NO se hace acá. Lo resuelve la IA en la segunda pasada
 * de extracción, que recibe los renglones del remito numerados y devuelve,
 * por cada línea de la factura, a cuál corresponde. Es a propósito: la
 * equivalencia entre el código del proveedor y el nuestro casi no está
 * cargada en Tango (CPA15 cubre 539 de 9.154 artículos), así que emparejar
 * por código no funciona, y emparejar por descripción con reglas fijas es
 * frágil. Acá solo queda aritmética, que se puede testear sin IA.
 */

/** Un renglón del remito, tal como sale de STA20. */
export type LineaRemito = {
  /** 1..N. Es el número con el que la IA lo identifica en la segunda pasada. */
  indice: number
  codArticulo: string
  descripcion: string | null
  cantidad: number
  /** Para poder señalar el renglón exacto en el mensaje. */
  numeroRemito: string
  /**
   * El código con el que este proveedor llama al artículo, si ya está
   * cargado en CPA15. Se le muestra al modelo para que empareje por ahí en
   * vez de tener que deducirlo de la descripción.
   */
  codigoProveedor?: string | null
}

/** Un renglón leído de la factura en la segunda pasada. */
export type RenglonFacturado = {
  /** El `indice` del renglón del remito al que la IA lo emparejó. 0 = ninguno. */
  lineaRemito: number
  descripcion: string | null
  /** Como lo leyó la IA, sin parsear: "12", "1.200,50". */
  cantidad: string | null
  precioUnitario: string | null
  /**
   * El porcentaje de bonificación de la línea, como lo imprime la factura.
   * El precio unitario suele ser el de lista, ANTES del descuento, y el
   * importe ya viene descontado: sin esto la suma de los renglones no
   * cierra contra el neto gravado de la cabecera.
   */
  bonificacion: string | null
  /**
   * El código con el que el proveedor identifica el artículo en SU factura.
   * Es lo que se guarda en `CPA15.COD_SINONI` cuando el operador confirma
   * el emparejamiento, para que la próxima factura del mismo proveedor se
   * resuelva sola.
   */
  codigoProveedor: string | null
}

export type Diferencia =
  | {
      tipo: 'cantidad'
      /** El renglón del remito involucrado. */
      linea: LineaRemito
      cantidadRemito: number
      cantidadFacturada: number
    }
  | { tipo: 'falta-en-factura'; linea: LineaRemito }
  | { tipo: 'no-esta-en-remito'; descripcion: string | null; cantidadFacturada: number }
  | {
      tipo: 'repetido'
      linea: LineaRemito
      /** Cuántas líneas de la factura apuntan al mismo renglón del remito. */
      veces: number
    }

/**
 * Las cantidades son DECIMAL(19,4) en la base y vienen de parsear texto de
 * un PDF, así que comparar con `===` deja pasar diferencias de redondeo que
 * no existen. Se comparan a cuatro decimales, la precisión de la columna.
 */
const EPSILON = 0.00005

function igual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON
}

/**
 * Devuelve las diferencias entre la factura y el remito. Array vacío
 * significa que coinciden.
 *
 * El orden importa para el mensaje que lee el operador: primero lo que
 * está mal en un renglón que sí existe (cantidad), después lo que falta, y
 * al final lo que sobra. Es el orden en que conviene revisarlo contra el
 * papel.
 */
export function cotejarRenglones(
  facturados: RenglonFacturado[],
  remito: LineaRemito[],
): Diferencia[] {
  const diferencias: Diferencia[] = []

  // Cuántas líneas de la factura apuntan a cada renglón del remito, y qué
  // cantidad suman entre todas. Sumar en vez de tomar la primera es lo
  // correcto cuando el proveedor parte un mismo artículo en dos líneas.
  const porLinea = new Map<number, { veces: number; cantidad: number }>()

  for (const f of facturados) {
    const cantidad = parsearImporte(f.cantidad)

    if (f.lineaRemito <= 0 || !remito.some((l) => l.indice === f.lineaRemito)) {
      diferencias.push({
        tipo: 'no-esta-en-remito',
        descripcion: f.descripcion,
        cantidadFacturada: cantidad,
      })
      continue
    }

    const acumulado = porLinea.get(f.lineaRemito) ?? { veces: 0, cantidad: 0 }
    porLinea.set(f.lineaRemito, {
      veces: acumulado.veces + 1,
      cantidad: acumulado.cantidad + cantidad,
    })
  }

  for (const linea of remito) {
    const facturado = porLinea.get(linea.indice)

    if (!facturado) {
      diferencias.push({ tipo: 'falta-en-factura', linea })
      continue
    }

    if (!igual(facturado.cantidad, linea.cantidad)) {
      diferencias.push({
        tipo: 'cantidad',
        linea,
        cantidadRemito: linea.cantidad,
        cantidadFacturada: facturado.cantidad,
      })
    }
  }

  // Lo de repetido va aparte y al final: no es un error por si mismo -- un
  // proveedor puede partir un articulo en dos lineas y sumar bien -- pero
  // si el operador tiene que resolver una diferencia, saber que ese
  // renglon aparece dos veces le ahorra buscarlo.
  for (const [indice, { veces }] of porLinea) {
    if (veces > 1) {
      const linea = remito.find((l) => l.indice === indice)
      if (linea) diferencias.push({ tipo: 'repetido', linea, veces })
    }
  }

  // Reordenado al final para no depender del orden en que se recorrio.
  const peso: Record<Diferencia['tipo'], number> = {
    cantidad: 0,
    'falta-en-factura': 1,
    'no-esta-en-remito': 2,
    repetido: 3,
  }
  return diferencias.sort((a, b) => peso[a.tipo] - peso[b.tipo])
}

/** Un número como lo escribe el operador: 12, 1,5 — sin ceros de relleno. */
function cant(n: number): string {
  return String(Math.round(n * 10000) / 10000).replace('.', ',')
}

/**
 * Las diferencias en texto, para la nota de observación. Una por línea,
 * nombrando el artículo y el remito: el operador tiene que poder ir al
 * papel sin abrir Tango.
 */
export function describirDiferencias(diferencias: Diferencia[]): string[] {
  return diferencias.map((d) => {
    switch (d.tipo) {
      case 'cantidad':
        return (
          `${d.linea.codArticulo} (${d.linea.descripcion ?? 'sin descripción'}): ` +
          `el remito ${d.linea.numeroRemito} entregó ${cant(d.cantidadRemito)} y la ` +
          `factura cobra ${cant(d.cantidadFacturada)}.`
        )
      case 'falta-en-factura':
        return (
          `${d.linea.codArticulo} (${d.linea.descripcion ?? 'sin descripción'}): está en ` +
          `el remito ${d.linea.numeroRemito} y la factura no lo cobra.`
        )
      case 'no-esta-en-remito':
        return (
          `"${d.descripcion ?? 'renglón sin descripción'}" (${cant(d.cantidadFacturada)}): ` +
          `la factura lo cobra y no está en ningún remito.`
        )
      case 'repetido':
        return (
          `${d.linea.codArticulo} (${d.linea.descripcion ?? 'sin descripción'}): la factura ` +
          `lo cobra en ${d.veces} renglones distintos.`
        )
    }
  })
}
