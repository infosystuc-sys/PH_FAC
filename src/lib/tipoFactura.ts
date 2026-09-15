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
 * Ninguno de estos siete se usa para registrar: `cae`, `vtocae` y
 * `ordencompra` no se graban en Tango ni se cotejan contra nada; el
 * vencimiento que va a CPA54 sale de la condición de compra, no del campo
 * `vencimiento` (ver comprobantes.ts); y `condiva` sale de la ficha del
 * proveedor en CPA01, que es la que manda.
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
  'vencimiento',
] as const

/**
 * Los números de remito solo se piden en facturas de artículos: son la
 * llave para traer de STA14/STA20 la mercadería que se está facturando. Un
 * servicio o una liquidación de tarjeta no vienen contra remito.
 */
const REMITOS = ['remito1', 'remito2'] as const

/**
 * `condpago` (el texto de la condición de pago/venta tal como lo imprime
 * el proveedor, ej. "Cuenta Corriente", "D026", "30-60-90 días") solo se
 * pide en artículos: es la única familia que deja `condcompra` vacía para
 * que el operador la elija -- conceptos y tarjeta arrancan siempre con
 * `COND_COMPRA_CONCEPTOS` fija (ver cola.ts), así que ahí no hay nada que
 * ayudar a resolver. Se usa para aprender, por proveedor, a qué condición
 * de compra de Tango corresponde ese texto (`resolverCondicionCompraEn` en
 * cola.ts, mismo mecanismo que aprendizajeImpuestos.ts para IVA/IIBB) --
 * decisión del usuario, 2026-08-23.
 */
const CONDICION_PAGO = ['condpago'] as const

/**
 * El descuento global del pie. Solo tiene sentido en artículos, donde hay
 * renglones contra los cuales aplicarlo (ver descuentoGlobal.ts). En
 * conceptos y tarjeta el neto viene impreso y no hay nada que descontar.
 */
const DESCUENTO_GENERAL = ['descuentogeneral'] as const

/**
 * Los slots que se le sacan a tarjeta para hacerle lugar al array de cargos
 * (ver ANALIZA_CARGOS). El array cuesta el equivalente a cuatro campos y
 * baja el techo de 35 a 31, asi que habia que liberar espacio.
 *
 * Se eligieron estos seis mirando las liquidaciones reales: ninguna de las
 * tres cargadas usa mas de dos slots de IVA (y en una de esas dos el
 * segundo resulto ser una percepcion del 3% mal leida) ni mas de una
 * percepcion de IIBB. Quedan tres slots de IVA y tres de percepcion, que es
 * mas de lo que cualquiera de las tres necesita.
 *
 * Si alguna vez aparece una liquidacion con cuatro alicuotas de IVA, el
 * dato se pierde sin que nada lo señale: el campo no se pide, no se guarda
 * y no se muestra. La contraparte es que el cotejo neto-IVA
 * (validarNetoContraIva) no cerraria, asi que el operador se enteraria por
 * ahi -- pero conviene tenerlo escrito.
 */
const SLOTS_LIBERADOS_TARJETA = [
  'porciva4',
  'impiva4',
  'porciva5',
  'impiva5',
  'percep4',
  'imppercep4',
] as const

export const CAMPOS_NO_ANALIZADOS: Record<TipoFactura, readonly string[]> = {
  conceptos: [...NO_ANALIZADOS_COMUNES, ...REMITOS, ...CONDICION_PAGO, ...DESCUENTO_GENERAL],
  // Los remitos salieron de articulos el 2026-09-06, cuando las facturas de
  // articulos pasaron a imputarse a una orden de compra en vez de cotejarse
  // contra un remito. No es solo que dejaran de usarse: hacen falta los dos
  // campos para que entre el array de renglones que ahora lee la IA --
  // medido contra la API, 34 campos + array lo rechaza y 32 lo acepta.
  // `leyendaAsiento` --la anotación manuscrita-- sale del schema de artículos
  // por falta de cupo, no porque no sirva ahí. Medido contra la API el
  // 2026-09-08: artículos con el array de renglones y 33 campos devuelve 400
  // "compiled grammar is too large", y con 32 entra. Es el único tipo sin
  // margen, y la anotación a mano aparece sobre todo en tickets de
  // combustible, que son facturas de conceptos. El campo se sigue mostrando
  // y se puede escribir a mano (ver `siempreVisible` en campos.ts): lo que
  // no hace en artículos es precargarse solo.
  //
  // El 5º slot de IVA salió de artículos el 2026-09-15 para hacerle lugar a
  // `descuentogeneral` y a los dos datos nuevos por renglón (precio y
  // subtotal impresos). Medido contra la API ese día: con 4 datos por ítem
  // el array entra con 31 campos de cabecera y no con 32. El slot no se
  // pierde nada: de las 16.522 facturas FP del historial de CPA04, ninguna
  // usó jamás COD_IVA5 (70 usaron el 4º).
  articulos: [...NO_ANALIZADOS_COMUNES, ...REMITOS, 'leyendaAsiento', 'porciva5', 'impiva5'],
  tarjeta: [
    ...NO_ANALIZADOS_COMUNES,
    ...REMITOS,
    ...CONDICION_PAGO,
    ...SLOTS_LIBERADOS_TARJETA,
    ...DESCUENTO_GENERAL,
  ],
}

/**
 * Si el tipo pide el desglose de cargos que componen el neto gravado (ver
 * `src/lib/cargos.ts`). Solo tarjeta: es el unico donde el neto no viene
 * impreso y hay que armarlo sumando.
 *
 * En conceptos y en articulos el neto figura como tal en el comprobante, asi
 * que pedir un desglose seria gastar cupo de schema --que en articulos ya
 * esta casi lleno, 34 de 35-- para reconstruir un dato que se puede leer
 * directo.
 */
export const ANALIZA_CARGOS: Record<TipoFactura, boolean> = {
  conceptos: false,
  articulos: false,
  tarjeta: true,
}

/**
 * Si el tipo pide los renglones del PDF para cotejarlos contra la orden de
 * compra (ver `src/lib/renglonesPdf.ts`). Solo articulos: es el unico que
 * se imputa a una OC.
 *
 * Distinto de ANALIZA_RENGLONES, que es el array de cinco datos del
 * circuito de remito -- ese sigue en false en los tres y desaparece con el
 * remito en la etapa siguiente.
 */
export const ANALIZA_RENGLONES_PDF: Record<TipoFactura, boolean> = {
  conceptos: false,
  articulos: true,
  tarjeta: false,
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
 * El grupo "Comprobante" se queda con cinco campos: tipo, punto de venta,
 * número, fecha de emisión y fecha contable. Con los tres cortos en 2 y las
 * dos fechas en 3 suman 12 -- dos filas parejas, con las fechas juntas en la
 * segunda, que es donde el operador las compara entre sí. El grupo
 * "Proveedor" no necesita
 * ajuste en conceptos/tarjeta: pierde tres campos (condiva, condpago,
 * vencimiento) y queda en 12 por su cuenta. En artículos solo pierde dos
 * (condiva, vencimiento) y `condpago` queda visible -- con su span de
 * catálogo (2) el grupo quedaría en 14, no múltiplo de 6, así que ahí
 * `condpago` pasa a ocupar la fila entera (6): es una condición de pago
 * completa ("Cuenta Corriente 90-120-150-180 días"), no un código corto
 * como el resto de esa fila.
 */
const COMPROBANTE_A_MEDIA_FILA = {
  tipo: 2,
  ptovta: 2,
  nro: 2,
  fecha: 3,
  fechacontable: 3,
}

const SPAN_POR_TIPO: Record<TipoFactura, Readonly<Record<string, number>>> = {
  conceptos: COMPROBANTE_A_MEDIA_FILA,
  // En artículos entra `descuentogeneral` (2) en la fila del neto: neto y
  // exento bajan de 3 a 2 para que la fila siga sumando 6.
  articulos: { ...COMPROBANTE_A_MEDIA_FILA, condpago: 6, neto: 2, exento: 2 },
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
