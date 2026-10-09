import { parsearImporte } from './formato'
import { parsearFechaArg } from './validaciones'

/**
 * El archivo "Mis Comprobantes" de ARCA, para verificar que lo cargado en
 * Tango sea lo que el fisco informa (2026-10-09, pedido del usuario).
 *
 * Las columnas se buscan POR NOMBRE y no por posición. ARCA cambia el orden
 * y agrega columnas entre exportaciones y entre años, y un parser por
 * posición se equivocaría de columna en silencio: leería el punto de venta
 * donde está el tipo y daría una conciliación entera mal sin avisar. Por
 * nombre, un formato que no se reconoce falla fuerte y dice qué encontró.
 */

export type ClaseComprobante = 'factura' | 'nota-credito' | 'nota-debito' | 'otro'

/** Lo que hace falta de cada comprobante informado, ya normalizado. */
export type ComprobanteArca = {
  fechaEmision: Date
  /** El código de ARCA: 1 = Factura A, 3 = NC A, 6 = Factura B... */
  tipoCodigo: number
  /** La letra, deducida del código. `null` si el código no se reconoce. */
  letra: string | null
  /** Qué es, para cruzarlo contra el `T_COMP` de Tango. */
  clase: ClaseComprobante
  puntoVenta: number
  numero: number
  cuitEmisor: string
  razonEmisor: string | null
  importeTotal: number
  importeNeto: number | null
  importeIva: number | null
}

/**
 * Los códigos de comprobante de ARCA que llegan a una cuenta a pagar.
 *
 * No están todos a propósito: los que no figuran caen en `'otro'` y la
 * conciliación los deja de lado en vez de inventarles una equivalencia. Un
 * recibo o un tique no entra por el circuito de compras de esta app.
 */
const TIPOS: Record<number, { letra: string; clase: ClaseComprobante }> = {
  1: { letra: 'A', clase: 'factura' },
  2: { letra: 'A', clase: 'nota-debito' },
  3: { letra: 'A', clase: 'nota-credito' },
  6: { letra: 'B', clase: 'factura' },
  7: { letra: 'B', clase: 'nota-debito' },
  8: { letra: 'B', clase: 'nota-credito' },
  11: { letra: 'C', clase: 'factura' },
  12: { letra: 'C', clase: 'nota-debito' },
  13: { letra: 'C', clase: 'nota-credito' },
  19: { letra: 'E', clase: 'factura' },
  20: { letra: 'E', clase: 'nota-debito' },
  21: { letra: 'E', clase: 'nota-credito' },
  51: { letra: 'M', clase: 'factura' },
  52: { letra: 'M', clase: 'nota-debito' },
  53: { letra: 'M', clase: 'nota-credito' },
  // Factura de Crédito Electrónica MiPyME: mismo papel, otro régimen.
  201: { letra: 'A', clase: 'factura' },
  202: { letra: 'A', clase: 'nota-debito' },
  203: { letra: 'A', clase: 'nota-credito' },
  206: { letra: 'B', clase: 'factura' },
  207: { letra: 'B', clase: 'nota-debito' },
  208: { letra: 'B', clase: 'nota-credito' },
  211: { letra: 'C', clase: 'factura' },
  212: { letra: 'C', clase: 'nota-debito' },
  213: { letra: 'C', clase: 'nota-credito' },
}

export function tipoArca(codigo: number): { letra: string; clase: ClaseComprobante } | null {
  return TIPOS[codigo] ?? null
}

/**
 * Las columnas que hacen falta y cómo reconocerlas. Se comparan contra el
 * encabezado sin acentos, en minúscula y con los espacios colapsados.
 *
 * Son patrones y no nombres exactos porque ARCA los escribe distinto según
 * la exportación: "Nro. Doc. Emisor", "Nro Doc Emisor", "Número de
 * Documento Emisor".
 */
const COLUMNAS = {
  fecha: /^fecha/,
  tipo: /^tipo( de)? comprobante$|^tipo$/,
  puntoVenta: /punto de venta|^pto\.? ?vta/,
  numero: /desde$|^(nro|numero)\.? ?(de )?comprobante$/,
  cuitEmisor: /(nro|numero)\.? ?(de )?doc\.? ?(umento)? ?emisor|cuit emisor/,
  razonEmisor: /denominacion emisor|razon social emisor/,
  total: /^imp\.? ?total$|^importe total$|^total$/,
  neto: /neto gravado/,
  iva: /^iva$|^imp\.? ?iva$/,
} as const

type Columna = keyof typeof COLUMNAS

/** Las que sin ellas no se puede conciliar nada. */
const OBLIGATORIAS: Columna[] = ['fecha', 'tipo', 'puntoVenta', 'numero', 'cuitEmisor', 'total']

export function normalizarEncabezado(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Qué columna del archivo corresponde a cada dato, y cuáles obligatorias
 * faltan. No se adivina por posición: si falta una, el archivo no se
 * importa.
 */
export function mapearColumnas(encabezados: string[]): {
  indices: Partial<Record<Columna, number>>
  faltan: Columna[]
} {
  const limpios = encabezados.map(normalizarEncabezado)
  const indices: Partial<Record<Columna, number>> = {}

  for (const campo of Object.keys(COLUMNAS) as Columna[]) {
    const i = limpios.findIndex((h) => COLUMNAS[campo].test(h))
    if (i >= 0) indices[campo] = i
  }

  return { indices, faltan: OBLIGATORIAS.filter((c) => indices[c] === undefined) }
}

/**
 * Separa una línea de CSV respetando las comillas: un campo entrecomillado
 * puede llevar adentro el separador, y la razón social lo lleva seguido
 * ("EMPRESA S.A., SUCURSAL NORTE").
 */
export function separarLinea(linea: string, separador: string): string[] {
  const campos: string[] = []
  let actual = ''
  let entreComillas = false

  for (let i = 0; i < linea.length; i += 1) {
    const c = linea[i]
    if (c === '"') {
      // Dos comillas seguidas adentro de un campo son una comilla literal.
      if (entreComillas && linea[i + 1] === '"') {
        actual += '"'
        i += 1
      } else {
        entreComillas = !entreComillas
      }
      continue
    }
    if (c === separador && !entreComillas) {
      campos.push(actual)
      actual = ''
      continue
    }
    actual += c
  }
  campos.push(actual)
  return campos.map((x) => x.trim())
}

/**
 * Con qué está separado el archivo. ARCA exporta con punto y coma en la
 * configuración regional argentina y con coma en otras, así que se deduce
 * en vez de asumirse: gana el que más campos produzca.
 */
export function detectarSeparador(linea: string): string {
  const candidatos = [';', ',', '\t']
  let mejor = ';'
  let max = 0
  for (const s of candidatos) {
    const n = separarLinea(linea, s).length
    if (n > max) {
      max = n
      mejor = s
    }
  }
  return mejor
}

export type ResultadoLectura =
  | { ok: true; comprobantes: ComprobanteArca[]; ignoradas: number }
  | { ok: false; error: string }

/**
 * Lee el archivo entero. No lanza: un archivo que no se entiende tiene que
 * explicarse, no reventar la pantalla.
 *
 * Las filas que no se pueden interpretar se CUENTAN y no se descartan en
 * silencio: una conciliación a la que le faltan filas sin avisar es peor
 * que una que no corre.
 */
export function leerArchivoArca(contenido: string): ResultadoLectura {
  const lineas = contenido
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (lineas.length === 0) return { ok: false, error: 'El archivo está vacío.' }

  // El encabezado no siempre es la primera línea: hay exportaciones que
  // arrancan con un título o con el CUIT del contribuyente. Se busca la
  // primera que tenga todas las columnas obligatorias.
  let fila = -1
  let separador = ';'
  let indices: Partial<Record<Columna, number>> = {}
  let faltanEnLaMejor: Columna[] = []
  let encabezadosDeLaMejor: string[] = []

  for (let i = 0; i < Math.min(lineas.length, 20); i += 1) {
    const sep = detectarSeparador(lineas[i])
    const encabezados = separarLinea(lineas[i], sep)
    const m = mapearColumnas(encabezados)
    if (m.faltan.length === 0) {
      fila = i
      separador = sep
      indices = m.indices
      break
    }
    // La "mejor" candidata, para que el mensaje de error muestre la fila
    // que más se parecía a un encabezado y no la primera cualquiera.
    if (encabezados.length > encabezadosDeLaMejor.length) {
      faltanEnLaMejor = m.faltan
      encabezadosDeLaMejor = encabezados
    }
  }

  if (fila < 0) {
    return {
      ok: false,
      error:
        `No se reconoce el formato: faltan las columnas ${faltanEnLaMejor.join(', ')}. ` +
        `El archivo trae ${encabezadosDeLaMejor.join(' · ')}. ` +
        `Tiene que ser la exportación de "Mis Comprobantes — Recibidos" de ARCA.`,
    }
  }

  const comprobantes: ComprobanteArca[] = []
  let ignoradas = 0
  const primerNumero = (texto: string): number => Number((texto.match(/\d+/) ?? [])[0])

  for (let i = fila + 1; i < lineas.length; i += 1) {
    const c = separarLinea(lineas[i], separador)
    const en = (campo: Columna): string => {
      const j = indices[campo]
      return j === undefined ? '' : (c[j] ?? '')
    }

    const fecha = parsearFechaArg(en('fecha'))
    const tipoCodigo = primerNumero(en('tipo'))
    const puntoVenta = primerNumero(en('puntoVenta'))
    const numero = primerNumero(en('numero'))
    const cuitEmisor = en('cuitEmisor').replace(/[^0-9]/g, '')

    if (
      !fecha ||
      !Number.isFinite(tipoCodigo) ||
      !Number.isFinite(puntoVenta) ||
      !Number.isFinite(numero) ||
      cuitEmisor.length !== 11
    ) {
      ignoradas += 1
      continue
    }

    const tipo = tipoArca(tipoCodigo)
    comprobantes.push({
      fechaEmision: fecha,
      tipoCodigo,
      letra: tipo?.letra ?? null,
      clase: tipo?.clase ?? 'otro',
      puntoVenta,
      numero,
      cuitEmisor,
      razonEmisor: en('razonEmisor') || null,
      importeTotal: parsearImporte(en('total')),
      importeNeto: indices.neto === undefined ? null : parsearImporte(en('neto')),
      importeIva: indices.iva === undefined ? null : parsearImporte(en('iva')),
    })
  }

  if (comprobantes.length === 0) {
    return { ok: false, error: 'Se reconoció el encabezado pero ninguna fila traía datos válidos.' }
  }
  return { ok: true, comprobantes, ignoradas }
}
