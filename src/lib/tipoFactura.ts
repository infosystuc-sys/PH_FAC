/**
 * Los tres tipos de comprobante que la app sabe importar. El operador lo
 * elige en el modal de importación, ANTES de que corra la IA, porque cada
 * tipo se lee con un prompt distinto (ver `src/server/ia/prompt.ts`): una
 * factura de servicios y un resumen de tarjeta no se interpretan igual, y
 * pedirle al modelo que además adivine de cuál se trata agrega un error
 * que el operador ya sabe evitar sin costo.
 *
 * Es la fuente única: de acá salen las opciones del modal de importación,
 * las del selector del formulario de revisión y las claves válidas de
 * `PHF_COMPROBANTE.TIPO_FACTURA`.
 */
export type TipoFactura = 'conceptos' | 'articulos' | 'tarjeta'

export type DefTipoFactura = {
  clave: TipoFactura
  label: string
  /** Qué entra en este tipo. Se muestra en el modal de importación. */
  ayuda: string
}

export const TIPOS_FACTURA: DefTipoFactura[] = [
  {
    clave: 'conceptos',
    label: 'Factura de conceptos',
    ayuda:
      'Servicios y gastos: telefonía, luz, gas, internet, seguros, alquiler, ' +
      'honorarios, fletes, publicidad. Se imputa por concepto, sin renglones.',
  },
  {
    clave: 'articulos',
    label: 'Factura de artículos',
    ayuda: 'Compra de mercadería con detalle de renglones, normalmente contra un remito.',
  },
  {
    clave: 'tarjeta',
    label: 'Liquidación de tarjeta',
    ayuda:
      'Resúmenes de VISA, Mastercard, Naranja, American Express y bancos. ' +
      'Se imputa al concepto de comisiones de tarjeta, sin detalle de cupones.',
  },
]

export const TIPO_FACTURA_DEFAULT: TipoFactura = 'conceptos'

/**
 * El techo real del JSON Schema, medido contra la API el 2026-08-15 por
 * bisección (ver `scripts/verificar-schema.ts`, que lo vuelve a medir):
 *
 *   sin el array de renglones ... 35 campos
 *   con el array de renglones ... 31 campos
 *
 * No es un límite de campos sino del tamaño de la gramática compilada que
 * structured outputs arma para forzar la forma de la respuesta. El array
 * pesa el equivalente a cuatro campos porque su largo no está acotado.
 * Arriba del techo la API devuelve 400 "compiled grammar is too large"
 * antes de que el modelo mire el PDF.
 *
 * Vale la pena tenerlo escrito: el catálogo pasó de 29 a 39 campos con la
 * reforma de percepciones y durante ese lapso NINGÚN tipo se pudo
 * importar, sin que nada lo señalara hasta que se midió.
 */
export const MAX_CAMPOS_SIN_RENGLONES = 35
export const MAX_CAMPOS_CON_RENGLONES = 31

/**
 * Los campos del catálogo que la IA NO analiza, aunque `extraePorIA` esté
 * en true. Un campo que no se pide no entra al JSON Schema, no se nombra
 * en el prompt, no se guarda en PHF_CAMPO y no se muestra en el
 * formulario.
 *
 * Ninguno de estos ocho se usa para registrar: `cae`, `vtocae` y
 * `ordencompra` no se graban en Tango ni se cotejan contra nada; el
 * vencimiento que va a CPA54 sale de la condición de compra, no del campo
 * `vencimiento` (ver comprobantes.ts); y `condiva`/`condpago` salen de la
 * ficha del proveedor en CPA01, que es la que manda.
 *
 * `moneda` y `cotizacion` SÍ se graban en la cabecera, pero los
 * comprobantes que la app importa son siempre en pesos, así que los
 * valores por defecto del registro -- ARS y cotización 1 -- son los
 * correctos. Si alguna vez entrara uno en moneda extranjera habría que
 * sacarlos de esta lista: sin el dato, se registraría en pesos sin que
 * nada lo señale.
 */
const NO_ANALIZADOS_COMUNES = [
  'cae',
  'vtocae',
  'moneda',
  'cotizacion',
  'ordencompra',
  'condiva',
  'condpago',
  'vencimiento',
] as const

/**
 * Los números de remito solo se piden en facturas de artículos: son la
 * llave para traer de STA14/STA20 la mercadería que se está facturando. Un
 * servicio o una liquidación de tarjeta no vienen contra remito.
 */
const REMITOS = ['remito1', 'remito2'] as const

export const CAMPOS_NO_ANALIZADOS: Record<TipoFactura, readonly string[]> = {
  conceptos: [...NO_ANALIZADOS_COMUNES, ...REMITOS],
  articulos: NO_ANALIZADOS_COMUNES,
  tarjeta: [...NO_ANALIZADOS_COMUNES, ...REMITOS],
}

/** Las claves de remito que la IA lee, en orden. */
export const CLAVES_REMITO: readonly string[] = REMITOS

/**
 * Si el tipo pide el array de renglones en el schema. Ninguno lo pide: de
 * los comprobantes solo se leen subtotales, totales e impuestos.
 *
 * En conceptos y en tarjeta el detalle nunca se cargó en Tango -- se
 * imputa por concepto contra la cabecera. En artículos el detalle sí se
 * carga, pero no sale del PDF: sale del remito. La IA lee el NÚMERO de
 * remito (ver CAMPOS_NO_ANALIZADOS) y los renglones se traen de
 * STA14/STA20, que es la fuente de verdad de qué mercadería entró. Leerlos
 * del PDF era pedirle al modelo que transcriba lo que Tango ya sabe, con
 * el riesgo de que transcriba mal.
 *
 * Sacarlo del schema es más fuerte que pedirle al modelo que devuelva el
 * array vacío: ya no puede devolver otra cosa. Volver a activarlo en un
 * tipo es cambiar el false por true acá, pero hay que rehacer la cuenta
 * -- con array el techo baja de 35 a 31 campos.
 */
export const ANALIZA_RENGLONES: Record<TipoFactura, boolean> = {
  conceptos: false,
  articulos: false,
  tarjeta: false,
}

/** Si la IA analiza `clave` en comprobantes de este tipo. */
export function analizaCampo(tipo: TipoFactura, clave: string): boolean {
  return !CAMPOS_NO_ANALIZADOS[tipo].includes(clave)
}

/**
 * Ancho distinto en la grilla para algunos campos de un tipo. Cada grupo
 * del formulario tiene que sumar un múltiplo de 6 o la última fila queda
 * a medio llenar, y al ocultar campos las cuentas del catálogo dejan de
 * dar.
 *
 * El grupo "Comprobante" se queda con cuatro campos. Con el span 2 del
 * catálogo suman 8: una fila de tres y una de uno solo. Con span 3 suman
 * 12 -- dos filas de dos, parejas. El grupo "Proveedor" no necesita
 * ajuste: pierde tres campos y queda en 12 por su cuenta.
 */
const COMPROBANTE_A_MEDIA_FILA = { tipo: 3, ptovta: 3, nro: 3, fecha: 3 }

const SPAN_POR_TIPO: Record<TipoFactura, Readonly<Record<string, number>>> = {
  conceptos: COMPROBANTE_A_MEDIA_FILA,
  articulos: COMPROBANTE_A_MEDIA_FILA,
  tarjeta: COMPROBANTE_A_MEDIA_FILA,
}

/** El ancho de `clave` en la grilla de este tipo, o `span` si no cambia. */
export function spanDe(tipo: TipoFactura, clave: string, span: number): number {
  return SPAN_POR_TIPO[tipo][clave] ?? span
}

export function esTipoFactura(v: string | null | undefined): v is TipoFactura {
  return TIPOS_FACTURA.some((t) => t.clave === v)
}

/** Cae al default en vez de lanzar: un valor viejo o vacío no puede colgar la cola. */
export function tipoFacturaODefault(v: string | null | undefined): TipoFactura {
  return esTipoFactura(v) ? v : TIPO_FACTURA_DEFAULT
}
