import { CLAVES_RENGLON } from './renglones'

export type GrupoCampo = 'comprobante' | 'proveedor' | 'importes' | 'imputacion'
export type TipoCampo = 'texto' | 'fecha' | 'decimal'

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

  // Importes — 18 = 3 filas de 6
  c('neto',        'Neto gravado 21%',      'importes',    2, 'decimal', true),
  c('iva21',       'IVA 21%',               'importes',    2, 'decimal', true),
  c('iva105',      'IVA 10,5%',             'importes',    2, 'decimal', true),
  c('exento',      'No gravado / exento',   'importes',    2, 'decimal', true),
  c('perciva',     'Percepción IVA',        'importes',    2, 'decimal', true),
  c('perciibb',    'Percepción IIBB',       'importes',    2, 'decimal', true),
  c('total',       'Total del comprobante', 'importes',    3, 'decimal', true),
  { clave: 'imputado', label: 'Total imputado', grupo: 'importes', span: 3,
    tipo: 'decimal', mono: true, extraePorIA: false, soloLectura: true },

  // Imputación en Tango — 6 = 1 fila. Ninguno lo extrae la IA:
  // `codprovee` se resuelve del CUIT, `condcompra` lo elige el operador.
  { clave: 'codprovee', label: 'Cód. proveedor Tango', grupo: 'imputacion', span: 3,
    tipo: 'texto', mono: true, extraePorIA: false, soloLectura: true },
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'texto', mono: false, extraePorIA: false, soloLectura: false },
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
 * rechazar el schema por costo de compilación exponencial -- con 21 campos
 * más 5 claves de renglón, un `anyOf: [string, null]` en cada uno suma 26 y
 * la API devuelve 400. Por eso la convención es: cadena vacía significa
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
 */
export function schemaExtraccion(): Record<string, unknown> {
  const campos: Record<string, unknown> = {}
  for (const x of CAMPOS_IA) {
    campos[x.clave] = objeto({
      valor: VALOR,
      confianza: { type: 'number' },
    })
  }

  const renglon: Record<string, unknown> = {}
  for (const k of CLAVES_RENGLON) renglon[k] = VALOR

  return objeto({
    campos: objeto(campos),
    renglones: { type: 'array', items: objeto(renglon) },
  })
}
