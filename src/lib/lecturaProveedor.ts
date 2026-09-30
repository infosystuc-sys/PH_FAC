import { parsearDesgloseTalles } from './talles'
import { normalizarCodigo } from './cotejoOc'

/**
 * Cómo viene armado, en las facturas de un proveedor, el código de los
 * artículos que en Tango llevan ESCALA.
 *
 * Tango define un artículo con escala como un código base más una variante
 * por combinación de color y/o talle, con el sufijo pegado al final
 * (`STA11.USA_ESC`: ver `Escala` en server/tango/articulos.ts). El papel no
 * imprime ese código armado: cada proveedor lo reparte a su manera, y es
 * esa manera lo que hay que recordar.
 *
 *   'columna-color'   El color va en una columna aparte, al lado del
 *                     código. DASS imprime "1261095" y "140"; el artículo
 *                     de Tango es `1261095140`. Una línea impresa es UN
 *                     artículo.
 *   'desglose-talle'  El renglón trae debajo las cantidades por talle
 *                     ("L : 6  M : 4  S : 2  XL : 4"). TOPPER. Una línea
 *                     impresa son VARIOS artículos, uno por talle -- lo
 *                     resuelve `abrirPorTalle`.
 *   'ninguna'         El proveedor no vende artículos con escala, o imprime
 *                     el código ya armado. Es el caso de la gran mayoría:
 *                     medido el 2026-09-30, 7.294 de los 9.565 artículos
 *                     del maestro no usan escala.
 *
 * Se guarda por proveedor y no por artículo a propósito (decisión del
 * usuario, 2026-09-30). Lo aprendido por artículo --el sinónimo de CPA15,
 * la descripción de PHF_ARTICULO_PROVEEDOR-- no sirve acá: un proveedor de
 * indumentaria tiene cientos de colores y talles, y enseñar de a uno no
 * termina nunca. La forma de leer, en cambio, es una sola por proveedor y
 * vale también para el artículo que se factura por primera vez.
 */
export const ESCALAS_LECTURA = ['columna-color', 'desglose-talle', 'ninguna'] as const

export type EscalaLectura = (typeof ESCALAS_LECTURA)[number]

export type ReglaLectura = {
  codProvee: string
  escala: EscalaLectura
  comprobantes: number
  /** La puso el operador a mano: la deducción automática no la pisa. */
  manual: boolean
}

export function esEscalaLectura(v: unknown): v is EscalaLectura {
  return typeof v === 'string' && (ESCALAS_LECTURA as readonly string[]).includes(v)
}

/** Cómo se muestra la regla en pantalla. */
export const ETIQUETA_ESCALA: Record<EscalaLectura, string> = {
  'columna-color': 'El color va en una columna aparte del código',
  'desglose-talle': 'El renglón se desglosa por talle',
  ninguna: 'Sin escala: el código viene completo',
}

/** Un renglón leído del PDF, con lo justo para deducir la regla. */
export type LineaParaDeducir = {
  codigo: string | null
  descripcion: string | null
}

/** Lo que el maestro dice de los códigos impresos de un comprobante. */
export type EvidenciaEscala = {
  /** Códigos impresos (normalizados) que son un artículo BASE de Tango. */
  bases: Set<string>
  /** Códigos impresos (normalizados) que son una VARIANTE de escala. */
  variantes: Set<string>
}

/**
 * Qué regla explica lo que se leyó de ESTE comprobante, o `null` si no hay
 * evidencia suficiente.
 *
 * Mira las dos caras, y eso importa: la regla tiene que poder aprenderse
 * tanto de una lectura que SALIÓ MAL como de una que salió bien. Si solo
 * mirara el fallo, el día que el prompt empezara a leer el color la
 * evidencia desaparecería y no se aprendería nunca más.
 *
 *  - `desglose-talle` si algún renglón trae el desglose de talles. Es la
 *    señal más fuerte: el formato "L : 6  M : 4" no aparece por casualidad.
 *  - `columna-color` si algún código impreso es un artículo BASE (le faltó
 *    el sufijo: la lectura se quedó corta) o si es una VARIANTE que vino
 *    partida en dos partes, como "1261095 140" (la lectura acertó, y la
 *    forma en que acertó es justamente la regla).
 *  - `null` en cualquier otro caso. No se deduce 'ninguna' por ausencia de
 *    evidencia: que una factura no traiga artículos con escala no dice nada
 *    sobre la siguiente. 'ninguna' solo se guarda si la elige el operador.
 */
export function deducirRegla(
  lineas: LineaParaDeducir[],
  evidencia: EvidenciaEscala,
): EscalaLectura | null {
  if (lineas.some((l) => parsearDesgloseTalles(l.descripcion).length > 0)) {
    return 'desglose-talle'
  }

  for (const l of lineas) {
    const impreso = (l.codigo ?? '').trim()
    const clave = normalizarCodigo(impreso)
    if (clave === '') continue
    // La lectura se quedo corta: el proveedor imprimio el base.
    if (evidencia.bases.has(clave)) return 'columna-color'
    // La lectura acerto, y acerto juntando dos partes separadas.
    if (evidencia.variantes.has(clave) && /[^A-Za-z0-9]/.test(impreso)) return 'columna-color'
  }
  return null
}

/**
 * Si la regla nueva reemplaza a la guardada.
 *
 * Una regla puesta a mano por el operador no la pisa nada automático: si
 * eligió una, es porque conoce al proveedor mejor que la deducción. Entre
 * dos automáticas gana la nueva, que se dedujo del comprobante que se está
 * leyendo; y si son iguales no se reemplaza, solo se suma el conteo.
 */
export function debeReemplazar(
  guardada: ReglaLectura | null,
  nueva: EscalaLectura,
  porOperador: boolean,
): boolean {
  if (!guardada) return true
  if (guardada.manual && !porOperador) return false
  return guardada.escala !== nueva || porOperador
}
