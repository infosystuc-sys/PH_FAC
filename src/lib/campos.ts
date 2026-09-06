import { CLAVES_RENGLON } from './renglones'
import { CLAVES_CARGO } from './cargos'
import { CLAVES_RENGLON_PDF } from './renglonesPdf'
import {
  ANALIZA_RENGLONES,
  ANALIZA_CARGOS,
  ANALIZA_RENGLONES_PDF,
  analizaCampo,
  type TipoFactura,
} from './tipoFactura'

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
  // Solo en facturas de articulos: es el numero con el que se va contra
  // STA14 a traer los renglones del remito. Dos porque es comun que una
  // factura consolide dos remitos de la misma semana. Mono: el operador lo
  // coteja digito por digito contra el PDF.
  c('remito1',     'Remito 1',              'comprobante', 3, 'texto',   true),
  c('remito2',     'Remito 2',              'comprobante', 3, 'texto',   true),

  // Proveedor — 12 = 2 filas de 6
  c('razon',       'Razón social',          'proveedor',   3, 'texto',   false),
  c('cuit',        'CUIT',                  'proveedor',   3, 'texto',   true),
  c('condiva',     'Condición IVA',         'proveedor',   2, 'texto',   false),
  c('condpago',    'Condición de pago',     'proveedor',   2, 'texto',   false),
  c('vencimiento', 'Vencimiento',           'proveedor',   2, 'fecha',   true),
  // El proveedor de Tango va en esta seccion y no en "Imputacion": es la
  // respuesta a "quien nos vendio", igual que la razon social y el CUIT de
  // arriba, solo que resuelta contra CPA01 en vez de leida del PDF. La
  // celda de al lado -- el concepto asociado a ese proveedor -- la pinta el
  // formulario: sale de Tango, no se guarda en PHF_CAMPO.
  { clave: 'codprovee', label: 'Cód. proveedor Tango', grupo: 'proveedor', span: 3,
    tipo: 'texto', mono: true, extraePorIA: false, soloLectura: true },

  // Importes. Rehecho el 2026-08-05: Tango no guarda el neto por base,
  // guarda un neto gravado total y hasta cinco tripletas de
  // codigo/porcentaje/importe de IVA (CPA04). Ver design doc 2026-08-05,
  // seccion 3 y 11.
  //
  // Las tres familias de lineas se muestran igual -- tres celdas de span 2
  // por fila -- pero se identifican distinto y terminan en tablas distintas:
  //
  //   IVA        porcivaN  -> el PORCENTAJE identifica la alicuota de CPA14.
  //                          Va a los slots COD_IVA de la cabecera (CPA04).
  //                          La percepcion de IVA del 3% entra aca, resuelta
  //                          siempre al codigo 15 (decision del usuario).
  //   Percepcion percepN   -> la JURISDICCION identifica el codigo. El
  //                          porcentaje NO sirve: el 60 (Tucuman) y el 61
  //                          (Salta) son ambos 2,5%. Va a CPA18.
  //   Varios     variosN   -> el operador elige el codigo de una lista de 10
  //                          (impuesto interno, ganancias, municipales...).
  //                          Tambien va a CPA18.
  //
  // La celda del medio de cada fila -- a que codigo de Tango resuelve -- la
  // renderiza el formulario, no este bucle. En IVA y percepcion es una lista
  // desplegable que arranca mostrando lo que resolvio el sistema y deja al
  // operador corregirlo si la IA leyo mal; esa correccion se guarda en
  // codivaN/codpercepN. Esos campos estan en el catalogo (tienen que ser
  // claves validas de PHF_CAMPO) pero NO los pinta el bucle: los pinta la
  // celda del medio. Ver OCULTOS_EN_GRILLA mas abajo.
  c('neto',        'Neto gravado',          'importes',    3, 'decimal', true),
  c('exento',      'No gravado / exento',   'importes',    3, 'decimal', true),
  c('porciva1',    'Alícuota 1',            'importes',    2, 'porcentaje', true),
  c('impiva1',     'Importe 1',             'importes',    2, 'decimal', true),
  c('porciva2',    'Alícuota 2',            'importes',    2, 'porcentaje', true),
  c('impiva2',     'Importe 2',             'importes',    2, 'decimal', true),
  c('porciva3',    'Alícuota 3',            'importes',    2, 'porcentaje', true),
  c('impiva3',     'Importe 3',             'importes',    2, 'decimal', true),
  c('porciva4',    'Alícuota 4',            'importes',    2, 'porcentaje', true),
  c('impiva4',     'Importe 4',             'importes',    2, 'decimal', true),
  c('porciva5',    'Alícuota 5',            'importes',    2, 'porcentaje', true),
  c('impiva5',     'Importe 5',             'importes',    2, 'decimal', true),
  c('percep1',     'Percepción 1',          'importes',    2, 'texto',   false),
  c('imppercep1',  'Importe percep. 1',     'importes',    2, 'decimal', true),
  c('percep2',     'Percepción 2',          'importes',    2, 'texto',   false),
  c('imppercep2',  'Importe percep. 2',     'importes',    2, 'decimal', true),
  c('percep3',     'Percepción 3',          'importes',    2, 'texto',   false),
  c('imppercep3',  'Importe percep. 3',     'importes',    2, 'decimal', true),
  c('percep4',     'Percepción 4',          'importes',    2, 'texto',   false),
  c('imppercep4',  'Importe percep. 4',     'importes',    2, 'decimal', true),
  c('varios1',     'Impuestos varios 1',    'importes',    2, 'texto',   false),
  c('impvarios1',  'Importe varios 1',      'importes',    2, 'decimal', true),
  c('varios2',     'Impuestos varios 2',    'importes',    2, 'texto',   false),
  c('impvarios2',  'Importe varios 2',      'importes',    2, 'decimal', true),
  c('total',       'Total del comprobante', 'importes',    3, 'decimal', true),

  // Correccion manual del codigo de Tango, una por fila de IVA y de
  // percepcion. Vacio = vale lo que resolvio el sistema; con valor = el
  // operador lo corrigio y ese gana. Se limpia solo cuando se edita la
  // columna de la izquierda (el porcentaje o la jurisdiccion), para que no
  // quede un codigo viejo pegado a un dato que ya cambio.
  o('codiva1'),    o('codiva2'),    o('codiva3'),    o('codiva4'),    o('codiva5'),
  o('codpercep1'), o('codpercep2'), o('codpercep3'), o('codpercep4'),
  // Los varios se sumaron tarde a este patrón. Hasta 2026-09-04 `variosN`
  // guardaba directamente el código de Tango, así que no había ningún texto
  // del comprobante contra el cual aprender, y la elección del operador se
  // perdía comprobante a comprobante -- lo reportó el usuario con dos
  // liquidaciones seguidas de Tarjeta Naranja. Ahora `variosN` guarda el
  // rótulo impreso, como `percepN`, y el código elegido vive acá.
  o('codvarios1'), o('codvarios2'),
  { clave: 'imputado', label: 'Total imputado', grupo: 'importes', span: 3,
    tipo: 'decimal', mono: true, extraePorIA: false, soloLectura: true },

  // Imputación en Tango — 12 = 2 filas de 6. Ninguno lo extrae la IA:
  // `codprovee` se resuelve del CUIT, `condcompra` lo elige el operador.
  { clave: 'condcompra', label: 'Condición de compra', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  { clave: 'tipoFactura', label: 'Tipo de factura', grupo: 'imputacion', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },
  // Texto libre del operador, aparte de cualquier campo que lea la IA.
  // Reemplaza la leyenda de cada renglón del asiento -- ver
  // previsualizarAsientoEn en asiento.ts -- para dejar constancia de algo
  // que no sale del comprobante (un motivo de pago, una referencia interna).
  { clave: 'leyendaAsiento', label: 'Leyenda / observación del asiento', grupo: 'imputacion', span: 6,
    tipo: 'texto', mono: false, extraePorIA: false, soloLectura: false },
]

/** Correccion manual del codigo de Tango de una fila. No la extrae la IA. */
function o(clave: string): DefCampo {
  return {
    clave,
    label: 'En Tango',
    grupo: 'importes',
    span: 2,
    tipo: 'select',
    mono: false,
    extraePorIA: false,
    soloLectura: false,
  }
}

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

/**
 * Los campos que la IA analiza en un comprobante de este tipo. No todos
 * los tipos piden lo mismo: una factura de conceptos no tiene CAE que
 * cotejar ni renglones que cargar, así que pedirlos sería gastar schema y
 * atención del modelo en datos que después nadie usa. La lista de
 * excepciones vive en tipoFactura.ts, al lado de la definición del tipo.
 */
export function camposIaPara(tipo: TipoFactura): DefCampo[] {
  return CAMPOS_IA.filter((x) => analizaCampo(tipo, x.clave))
}

/**
 * Los que el bucle del formulario NO pinta: los pinta la celda del medio de
 * su propia fila, que necesita la resolucion en vivo para saber que mostrar
 * cuando el operador todavia no corrigio nada. Ocupan lugar en la grilla
 * igual -- son esa celda -- asi que sus spans si cuentan para el ancho.
 */
export const OCULTOS_EN_GRILLA = /^(?:codiva[1-5]|codpercep[1-4]|codvarios[12])$/

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
export function schemaExtraccion(tipo: TipoFactura): Record<string, unknown> {
  const valores: Record<string, unknown> = {}
  const confianzas: Record<string, unknown> = {}
  for (const x of camposIaPara(tipo)) {
    valores[x.clave] = VALOR
    confianzas[x.clave] = { type: 'number' }
  }

  const props: Record<string, unknown> = {
    valores: objeto(valores),
    confianzas: objeto(confianzas),
  }

  // En conceptos el array de renglones no está en el schema, no viene
  // vacío: el comprobante se imputa por concepto contra la cabecera. Es
  // una garantía más fuerte que pedírselo por prompt, y además le saca al
  // schema el único objeto de tamaño no acotado que tenía.
  if (ANALIZA_RENGLONES[tipo]) {
    const renglon: Record<string, unknown> = {}
    for (const k of CLAVES_RENGLON) renglon[k] = VALOR
    props.renglones = { type: 'array', items: objeto(renglon) }
  }

  // Los cargos que componen el neto gravado de una liquidación de tarjeta.
  // Va como array y no como pares de campos fijos porque la cantidad
  // cambia con cada procesadora -- dos en Valle Fértil, cinco en Tarjeta
  // Sol -- y unos pares fijos obligarían a elegir un máximo que igual se
  // quedaría corto. Cuesta lo mismo que ~4 campos, que es lo que se liberó
  // en tarjeta (ver SLOTS_LIBERADOS_TARJETA).
  if (ANALIZA_CARGOS[tipo]) {
    const cargo: Record<string, unknown> = {}
    for (const k of CLAVES_CARGO) cargo[k] = VALOR
    props.cargos = { type: 'array', items: objeto(cargo) }
  }

  // Los renglones del PDF de una factura de artículos, para cotejarlos
  // contra la orden de compra. Dos datos por ítem y no cinco: con los 32
  // campos de cabecera, el array de cinco no entra en el techo de la
  // gramática y el de dos sí (medido contra la API, 2026-09-06).
  if (ANALIZA_RENGLONES_PDF[tipo]) {
    const renglon: Record<string, unknown> = {}
    for (const k of CLAVES_RENGLON_PDF) renglon[k] = VALOR
    props.renglonesPdf = { type: 'array', items: objeto(renglon) }
  }

  return objeto(props)
}
