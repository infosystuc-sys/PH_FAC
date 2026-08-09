import { CLAVES_RENGLON } from './renglones'

export type GrupoCampo = 'comprobante' | 'proveedor' | 'importes' | 'imputacion'
/**
 * `porcentaje` es distinto de `decimal` a propósito: los `porcivaN` son
 * alícuotas (21, 27, 3...), no importes. `totalImputado` (en formato.ts)
 * se apoya en esta distinción para no sumarlos -- si fueran `decimal`
 * como el resto, entrarían en la suma y el total imputado quedaría mal
 * por unas decenas sin que nada lo señale.
 */
export type TipoCampo = 'texto' | 'fecha' | 'decimal' | 'porcentaje' | 'select'

export type DefCampo = {
  clave: string
  label: string
  grupo: GrupoCampo
  /** Ancho en la grilla de 6 columnas del grupo. */
  span: number
  tipo: TipoCampo
  /** IBM Plex Mono: todo dato que el operador cotejá contra el PDF. */
  mono: boolean
  extraePorIA: boolean
  soloLectura: boolean
}

/**
 * La fuente de verdad de los campos. De acá salen tres cosas que si no
 * estarían repetidas: el JSON Schema que se le pide a Claude, las claves
 * válidas de PHF_CAMPO.CLAVE, y el render del formulario de revisión.
 *
 * El orden es el orden en que se muestran.
 */
export const CAMPOS: DefCampo[] = [
  // Comprobante — 18 = 3 filas de 6
  c('tipo',        'Tipo',                  'comprobante', 2, 'texto',   false),
  c('ptovta',      'Punto de venta',        'comprobante', 2, 'texto',   true),
  c('nro',         'Número',                'comprobante', 2, 'texto',   true),
  c('fecha',       'Fecha de emisión',      'comprobante', 2, 'fecha',   true),
  c('cae',         'CAE',                   'comprobante', 2, 'texto',   true),
  c('vtocae',      'Vto. CAE',              'comprobante', 2, 'fecha',   true),
  c('moneda',      'Moneda',                'comprobante', 2, 'texto',   false),
  c('cotizacion',  'Cotización',            'comprobante', 2, 'decimal', true),
  c('ordencompra', 'Orden de compra',       'comprobante', 2, 'texto',   true),

  // Proveedor — 12 = 2 filas de 6
  c('razon',       'Razón social',          'proveedor',   3, 'texto',   false),
  c('cuit',        'CUIT',                  'proveedor',   3, 'texto',   true),
  c('condiva',     'Condición IVA',         'proveedor',   2, 'texto',   false),
  c('condpago',    'Condición de pago',     'proveedor',   2, 'texto',   false),
  c('vencimiento', 'Vencimiento',           'proveedor',   2, 'fecha',   true),

  // Importes — 54 = 9 filas de 6. Rehecho el 2026-08-05: Tango no guarda el
  // neto por base, guarda un neto gravado total y hasta cinco tripletas de
  // codigo/porcentaje/importe de IVA (CPA04). Los pares porcivaN/impivaN
  // van intercalados a proposito -- cada par ocupa una fila completa de la
  // grilla (2 + 4 = 6) -- y mezclan alicuotas con percepciones de la
  // familia IVA, que es como Tango las guarda de verdad. Ver design doc
  // 2026-08-05, seccion 3 y 11. codpercibb/codpercepiva (Fase 4) resuelven
  // la ambiguedad de codigo de Tango que el porcentaje/importe solo no
  // alcanza a distinguir -- ver spec de Fase 4, seccion 2.
  c('neto',        'Neto gravado',          'importes',    3, 'decimal', true),
  c('exento',      'No gravado / exento',   'importes',    3, 'decimal', true),
  c('porciva1',    'Alícuota 1',            'importes',    2, 'porcentaje', true),
  c('impiva1',     'Importe 1',             'importes',    4, 'decimal', true),
  c('porciva2',    'Alícuota 2',            'importes',    2, 'porcentaje', true),
  c('impiva2',     'Importe 2',             'importes',    4, 'decimal', true),
  { clave: 'codpercepiva', label: 'Código percepción IVA 3%', grupo: 'importes', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  c('porciva3',    'Alícuota 3',            'importes',    2, 'porcentaje', true),
  c('impiva3',     'Importe 3',             'importes',    4, 'decimal', true),
  c('porciva4',    'Alícuota 4',            'importes',    2, 'porcentaje', true),
  c('impiva4',     'Importe 4',             'importes',    4, 'decimal', true),
  c('porciva5',    'Alícuota 5',            'importes',    2, 'porcentaje', true),
  c('impiva5',     'Importe 5',             'importes',    4, 'decimal', true),
  c('perciibb',    'Percepción IIBB',       'importes',    3, 'decimal', true),
  { clave: 'codpercibb', label: 'Código percepción IIBB', grupo: 'importes', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  c('impint',      'Impuesto interno',      'importes',    3, 'decimal', true),
  c('total',       'Total del comprobante', 'importes',    3, 'decimal', true),
  { clave: 'imputado', label: 'Total imputado', grupo: 'importes', span: 3,
    tipo: 'decimal', mono: true, extraePorIA: false, soloLectura: true },

  // Imputación en Tango — 6 = 1 fila. Ninguno lo extrae la IA:
  // `codprovee` se resuelve del CUIT, `condcompra` lo elige el operador.
  { clave: 'codprovee', label: 'Cód. proveedor Tango', grupo: 'imputacion', span: 3,
    tipo: 'texto', mono: true, extraePorIA: false, soloLectura: true },
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  { clave: 'tipoFactura', label: 'Tipo de factura', grupo: 'imputacion', span: 6,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
]

function c(
  clave: string,
  label: string,
  grupo: GrupoCampo,
  span: number,
  tipo: TipoCampo,
  mono: boolean,
): DefCampo {
  return { clave, label, grupo, span, tipo, mono, extraePorIA: true, soloLectura: false }
}

export const CAMPOS_IA: DefCampo[] = CAMPOS.filter((x) => x.extraePorIA)

const POR_CLAVE = new Map(CAMPOS.map((x) => [x.clave, x]))

export function campoPorClave(clave: string): DefCampo | undefined {
  return POR_CLAVE.get(clave)
}

export function esClaveValida(clave: string): boolean {
  return POR_CLAVE.has(clave)
}

export const GRUPOS: { clave: GrupoCampo; titulo: string }[] = [
  { clave: 'comprobante', titulo: 'Comprobante' },
  { clave: 'proveedor', titulo: 'Proveedor' },
  { clave: 'importes', titulo: 'Importes' },
  { clave: 'imputacion', titulo: 'Imputación en Tango' },
]

export function camposDelGrupo(grupo: GrupoCampo): DefCampo[] {
  return CAMPOS.filter((x) => x.grupo === grupo)
}

/**
 * `valor` es siempre string. Structured outputs limita a 16 los parámetros
 * con unión de tipos por request (`anyOf` o `type` como array) antes de
 * rechazar el schema por costo de compilación exponencial. Con el catálogo
 * original de 21 campos más 5 claves de renglón, un `anyOf: [string, null]`
 * en cada uno ya sumaba 26 uniones y la API devolvía 400; con los 29 campos
 * actuales sería peor. Por eso la convención es: cadena vacía significa
 * "no figura en el PDF". `parsearRespuesta` ya la traduce a `null` sola
 * (su helper `texto()` hace `t === '' ? null : t`).
 */
const VALOR = { type: 'string' }

function objeto(props: Record<string, unknown>) {
  return {
    type: 'object',
    properties: props,
    required: Object.keys(props),
    additionalProperties: false,
  }
}

/**
 * El JSON Schema de `output_config.format`. Structured outputs exige
 * `additionalProperties: false` y `required` en todos los objetos.
 *
 * `valores` y `confianzas` van **aplanados**, no un objeto `{valor,
 * confianza}` por campo. Con 29 campos anidados de esa forma la API
 * rechazaba el schema real contra un PDF real: "compiled grammar is too
 * large" (400). 29 objetos gramaticales de dos propiedades cada uno pesan
 * mucho más para el compilador de la gramática que dos objetos de 29
 * propiedades cada uno, aunque la cantidad total de campos sea la misma.
 * La semántica no cambia: misma clave, mismo campo, misma convención de
 * cadena vacía para "no figura" -- solo se aplana la anidación.
 */
export function schemaExtraccion(): Record<string, unknown> {
  const valores: Record<string, unknown> = {}
  const confianzas: Record<string, unknown> = {}
  for (const x of CAMPOS_IA) {
    valores[x.clave] = VALOR
    confianzas[x.clave] = { type: 'number' }
  }

  const renglon: Record<string, unknown> = {}
  for (const k of CLAVES_RENGLON) renglon[k] = VALOR

  return objeto({
    valores: objeto(valores),
    confianzas: objeto(confianzas),
    renglones: { type: 'array', items: objeto(renglon) },
  })
}
