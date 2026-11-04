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

/**
 * El largo de `CPA04.LEYENDA`: varchar(30),
 * verificado contra la base real.
 *
 * Vive en el catalogo de campos y no al lado del INSERT porque es el tope
 * del input de la observacion en la revision, ademas del de la columna: son
 * el mismo numero y separarlos los dejaria desincronizarse.
 */
export const LARGO_LEYENDA_COMPROBANTE = 30

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
  /**
   * Tope de caracteres del input, cuando la columna de Tango que recibe el
   * campo es más corta que lo que el operador podría escribir. Sin tope, el
   * texto se recortaría recién al grabar, dentro de Tango, donde ya no se ve.
   */
  maxLargo?: number
  /**
   * Se muestra aunque la IA no lo analice en este tipo de comprobante.
   *
   * La regla general es que un campo que la IA no lee tampoco se muestre:
   * serían casilleros siempre vacíos (ver `camposVisibles`). Vale para los
   * campos cuya única fuente es la IA -- CAE, moneda, cotización --, pero no
   * para los que además escribe el operador: esconderlos lo dejaría sin
   * dónde tipearlos.
   */
  siempreVisible?: boolean
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
  // No la lee la IA: la calcula la app con la fecha de emisión y el cierre
  // contable de Tango (CPA10.CIERRE_CON). Es la que va a CPA04.FECHA_CONT,
  // y puede no ser la de emisión -- ver src/lib/fechaContable.ts. Editable:
  // el operador puede correrla a otro período abierto si hace falta.
  { clave: 'fechacontable', label: 'Fecha contable', grupo: 'comprobante', span: 4,
    tipo: 'fecha', mono: true, extraePorIA: false, soloLectura: false },
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
  // celda de al lado -- el concepto de Tango -- la pinta el formulario.
  { clave: 'codprovee', label: 'Cód. proveedor Tango', grupo: 'proveedor', span: 3,
    tipo: 'texto', mono: true, extraePorIA: false, soloLectura: true },
  // El concepto elegido para ESTE comprobante, cuando el operador no quiere
  // el de la ficha del proveedor (2026-09-17, pedido del usuario). Vacio =
  // vale el de la ficha; con valor = gana este, y la ficha no se toca. Mismo
  // patron que codivaN: esta en el catalogo para ser clave valida de
  // PHF_CAMPO, pero lo pinta la celda de al lado de codprovee (ver
  // OCULTOS_EN_GRILLA), que muestra el resuelto y deja cambiarlo.
  { clave: 'concepto', label: 'Concepto en Tango', grupo: 'proveedor', span: 3,
    tipo: 'select', mono: false, extraePorIA: false, soloLectura: false },

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
  // El descuento global que algunos proveedores imprimen al pie, antes del
  // neto gravado. Solo artículos (ver CAMPOS_NO_ANALIZADOS): es el dato que
  // permite saber si los subtotales impresos de los renglones ya son netos
  // o si hay que restarles el descuento para que cierren contra el neto.
  // Ver descuentoGlobal.ts. Pedido del usuario, 2026-09-15.
  c('descuentogeneral', 'Descuento general', 'importes',  2, 'decimal', true),
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
  // Texto del operador que reemplaza la leyenda de cada renglón del asiento
  // -- ver previsualizarAsientoEn en asiento.ts -- y desde el 2026-09-08 va
  // también a CPA04.LEYENDA.
  //
  // Desde el 2026-09-08 lo PRECARGA la IA con lo que esté escrito a mano en
  // el comprobante. Es el único campo que no sale del texto impreso: los
  // tickets de combustible vienen anotados a mano con la identificación del
  // vehículo ("DFSK - Log. - TC ICBC"), y eso es exactamente lo que el
  // operador venía copiando acá a mano. Sigue siendo editable: la IA propone
  // y el operador dispone, igual que con cualquier otro campo.
  //
  // Se topea en el largo de CPA04.LEYENDA (30), la más corta de las dos
  // columnas que lo reciben (ASIENTO_CP.DESC_LEYENDA admite 100). Decisión
  // del usuario: que el tope se vea al escribir, en vez de recortar el texto
  // al grabar.
  { clave: 'leyendaAsiento', label: 'Leyenda / observación del asiento', grupo: 'imputacion', span: 6,
    tipo: 'texto', mono: false, extraePorIA: true, soloLectura: false,
    maxLargo: LARGO_LEYENDA_COMPROBANTE, siempreVisible: true },
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
export const OCULTOS_EN_GRILLA = /^(?:codiva[1-5]|codpercep[1-4]|codvarios[12]|concepto)$/

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

/**
 * Los pares de campos que forman un "casillero" de impuesto en el grupo
 * Importes: la alícuota y su importe, el rótulo de la percepción y el suyo.
 *
 * Se tratan de a pares y no de a uno porque esconder la mitad de un
 * casillero no tiene sentido --un importe sin su alícuota no se puede
 * imputar-- y porque sacar un campo suelto descuadra la grilla de 6
 * columnas.
 */
export const PARES_IMPUESTO: readonly (readonly [string, string])[] = [
  ['porciva1', 'impiva1'],
  ['porciva2', 'impiva2'],
  ['porciva3', 'impiva3'],
  ['porciva4', 'impiva4'],
  ['porciva5', 'impiva5'],
  ['percep1', 'imppercep1'],
  ['percep2', 'imppercep2'],
  ['percep3', 'imppercep3'],
  ['percep4', 'imppercep4'],
  ['varios1', 'impvarios1'],
  ['varios2', 'impvarios2'],
]

/**
 * Qué campos de impuestos, alícuotas y percepciones se pueden esconder
 * porque el casillero entero está vacío (2026-10-08, pedido del usuario).
 *
 * Un comprobante usa dos o tres casilleros de los once, así que el grupo
 * Importes mostraba una veintena de casillas vacías en la pantalla donde el
 * operador pasa el día.
 *
 * Solo se esconde el par COMPLETO: si cualquiera de los dos tiene algo, los
 * dos quedan. Un importe cargado sin su alícuota es justo el caso que hay
 * que ver, no el que hay que tapar.
 */
export function clavesDeImpuestosVacios(valores: Record<string, string>): Set<string> {
  const ocultas = new Set<string>()
  for (const [a, b] of PARES_IMPUESTO) {
    const vacio = (c: string) => (valores[c] ?? '').trim() === ''
    if (vacio(a) && vacio(b)) {
      ocultas.add(a)
      ocultas.add(b)
    }
  }
  return ocultas
}
