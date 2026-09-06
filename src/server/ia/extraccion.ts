import Anthropic from '@anthropic-ai/sdk'
import { camposIaPara, schemaExtraccion } from '@/lib/campos'
import { CLAVES_RENGLON, type RenglonExtraido } from '@/lib/renglones'
import { CLAVES_CARGO, type CargoExtraido } from '@/lib/cargos'
import { CLAVES_RENGLON_PDF, type RenglonPdf } from '@/lib/renglonesPdf'
import {
  ANALIZA_RENGLONES,
  ANALIZA_CARGOS,
  ANALIZA_RENGLONES_PDF,
  type TipoFactura,
} from '@/lib/tipoFactura'
import { PROMPTS_EXTRACCION } from './prompt'

export type CampoExtraido = { valor: string | null; confianza: number }

export type Extraccion = {
  campos: Record<string, CampoExtraido>
  renglones: RenglonExtraido[]
  /** Los cargos que componen el neto gravado. Solo en tarjeta; vacío en el resto. */
  cargos: CargoExtraido[]
  /**
   * Los renglones leídos del PDF, para cotejar contra la orden de compra.
   * Solo en artículos; vacío en el resto. No se graban en Tango: lo que se
   * factura sale de la OC.
   */
  renglonesPdf: RenglonPdf[]
}

export type UsoTokens = { inputTokens: number; outputTokens: number }

export type ResultadoExtraccion =
  | { ok: true; extraccion: Extraccion; ms: number; modelo: string; usage: UsoTokens }
  | { ok: false; error: string }

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

let cliente: Anthropic | null = null
function getCliente(): Anthropic {
  if (!cliente) cliente = new Anthropic()
  return cliente
}

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

function confianza(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(1, Math.max(0, n))
}

/**
 * Convierte el JSON crudo en una `Extraccion`. Es tolerante a propósito: el
 * schema le pide a Claude una forma exacta, pero acá se asume que puede
 * llegar cualquier cosa. Un campo de más se descarta, uno de menos se
 * completa con null. Lo único que hace fallar es que el JSON no parsee o
 * que no venga el objeto `valores`.
 *
 * `valores` y `confianzas` llegan aplanados -- un string y un number por
 * campo, en vez de un objeto `{valor, confianza}` por campo -- porque así
 * los pide `schemaExtraccion` desde que la forma anidada rompió con
 * "compiled grammar is too large" contra un PDF real. Si falta
 * `confianzas` entero no se lanza: un valor sin confianza sigue siendo un
 * valor útil, así que esas confianzas quedan en 0.
 */
export function parsearRespuesta(texto_: string, tipo: TipoFactura): Extraccion {
  const crudo = JSON.parse(texto_) as Record<string, unknown>
  const esperados = camposIaPara(tipo)

  const valores_ = crudo.valores
  if (valores_ === null || typeof valores_ !== 'object') {
    throw new Error('La respuesta no trae el objeto `valores`.')
  }
  const dicValores = valores_ as Record<string, unknown>

  const confianzas_ = crudo.confianzas
  const dicConfianzas: Record<string, unknown> =
    confianzas_ !== null && typeof confianzas_ === 'object'
      ? (confianzas_ as Record<string, unknown>)
      : {}

  const campos: Record<string, CampoExtraido> = {}
  for (const def of esperados) {
    const valor = texto(dicValores[def.clave])
    campos[def.clave] = {
      valor,
      // Un campo sin valor no aporta confianza al promedio.
      confianza: valor === null ? 0 : confianza(dicConfianzas[def.clave]),
    }
  }

  // Hoy ningun tipo analiza renglones (ver ANALIZA_RENGLONES): de los
  // comprobantes solo se leen subtotales, totales e impuestos. El schema ni
  // siquiera los pide, pero si por lo que fuera vinieran igual se descartan
  // aca, para que un error del modelo no meta en PHF_RENGLON un detalle que
  // no se imputa.
  const renglones = ANALIZA_RENGLONES[tipo] ? parsearRenglones(crudo.renglones) : []

  // Los cargos que componen el neto gravado. Solo tarjeta los pide; en los
  // otros tipos se descartan aunque vinieran, mismo criterio que arriba.
  const cargos = ANALIZA_CARGOS[tipo] ? parsearCargos(crudo.cargos) : []

  // Los renglones del PDF, para cotejar contra la orden de compra. Solo
  // articulos los pide; en el resto se descartan aunque vinieran.
  const renglonesPdf = ANALIZA_RENGLONES_PDF[tipo] ? parsearRenglonesPdf(crudo.renglonesPdf) : []

  return { campos, renglones, cargos, renglonesPdf }
}

/** Los renglones del PDF. Uno sin código ni cantidad no sirve para cotejar. */
export function parsearRenglonesPdf(crudo: unknown): RenglonPdf[] {
  const renglones: RenglonPdf[] = []
  for (const r of Array.isArray(crudo) ? crudo : []) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const fila = Object.fromEntries(
      CLAVES_RENGLON_PDF.map((k) => [k, texto(o[k])]),
    ) as unknown as RenglonPdf
    if (fila.codigo === null && fila.cantidad === null) continue
    renglones.push(fila)
  }
  return renglones
}

/** Los cargos de la respuesta cruda. Un cargo sin importe no sirve para sumar. */
export function parsearCargos(crudo: unknown): CargoExtraido[] {
  const cargos: CargoExtraido[] = []
  for (const c of Array.isArray(crudo) ? crudo : []) {
    if (c === null || typeof c !== 'object') continue
    const o = c as Record<string, unknown>
    const fila = Object.fromEntries(
      CLAVES_CARGO.map((k) => [k, texto(o[k])]),
    ) as unknown as CargoExtraido
    if (fila.importe === null) continue
    cargos.push(fila)
  }
  return cargos
}

/**
 * Los renglones de la respuesta cruda. Va aparte de `parsearRespuesta`
 * porque ningun tipo los pide hoy: si estuviera en linea seria una rama
 * inalcanzable, y esto deja el parseo probado para cuando se vuelva a
 * activar `ANALIZA_RENGLONES` en algun tipo.
 */
export function parsearRenglones(crudo: unknown): RenglonExtraido[] {
  const renglones: RenglonExtraido[] = []
  for (const r of Array.isArray(crudo) ? crudo : []) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const fila = Object.fromEntries(
      CLAVES_RENGLON.map((k) => [k, texto(o[k])]),
    ) as unknown as RenglonExtraido
    // Un renglon sin un solo dato no es un renglon.
    if (CLAVES_RENGLON.every((k) => fila[k] === null)) continue
    renglones.push(fila)
  }
  return renglones
}

/**
 * Manda el PDF a Claude y devuelve los campos con su confianza. No lanza:
 * toda falla vuelve como `{ ok: false }` para que la cola decida si
 * reintenta o marca el comprobante en error.
 *
 * `tipo` es el que el operador eligió al importar y decide con qué prompt
 * se lee el comprobante: una factura de servicios, una de mercadería y un
 * resumen de tarjeta no se interpretan igual (sobre todo en qué hacer con
 * los renglones y dónde buscar las percepciones de Ingresos Brutos).
 */
export async function extraerDePdf(
  pdf: Buffer,
  tipo: TipoFactura,
): Promise<ResultadoExtraccion> {
  const arranque = Date.now()
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 16000,
      // En Opus 5 el pensamiento se cuenta DENTRO de max_tokens.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: schemaExtraccion(tipo) },
      },
      system: [
        {
          type: 'text',
          text: PROMPTS_EXTRACCION[tipo],
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            // El documento va antes del texto.
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdf.toString('base64'),
              },
            },
            { type: 'text', text: 'Extraé los campos de este comprobante.' },
          ],
        },
      ],
    })

    if (r.stop_reason === 'refusal') {
      return { ok: false, error: 'El modelo no procesó el comprobante.' }
    }

    const bloque = r.content.find((b) => b.type === 'text')
    if (!bloque || bloque.type !== 'text') {
      return { ok: false, error: 'La respuesta no trajo contenido de texto.' }
    }

    return {
      ok: true,
      extraccion: parsearRespuesta(bloque.text, tipo),
      ms: Date.now() - arranque,
      modelo: MODELO,
      // Base para medir el costo real por comprobante (RETOMAR.md): sin
      // esto, ni con más PDFs reales se podría calcular. La muestra en sí
      // (4-5 comprobantes más) sigue diferida a la Fase 4 por falta de
      // material, no por falta de este dato.
      usage: {
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
      },
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    // El llamador solo recibe el mensaje recortado -- acá queda el error
    // crudo, con stack si lo tiene, para poder diagnosticar un bug de
    // programación (a diferencia de una lectura de PDF que salió mal) sin
    // esperar a que la cola de la Task 6 agote los reintentos en silencio.
    console.error(`extraerDePdf[${arranque}]: fallo la extraccion:`, err)
    return { ok: false, error: mensaje.slice(0, 900) }
  }
}
