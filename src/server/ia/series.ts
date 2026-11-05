import Anthropic from '@anthropic-ai/sdk'
import { bloqueComprobante } from './extraccion'
import { usoDeRespuesta, type UsoTokens } from '@/lib/usoIa'
import type { ReglaSeries } from '@/lib/seriesProveedor'

/**
 * Lectura de los números de serie de un remito (2026-11-05, pedido del
 * usuario). Va en un llamado aparte de la cabecera por la misma razón que
 * la segunda pasada de renglones (ver renglones.ts): el schema principal
 * está en el techo de la gramática de structured outputs, y un array de
 * unidades adentro de cada renglón no entra. Además solo hace falta para
 * los proveedores con regla de series (`seriesProveedor.ts`): el resto no
 * paga este llamado.
 */

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

let cliente: Anthropic | null = null
function getCliente(): Anthropic {
  if (!cliente) cliente = new Anthropic()
  return cliente
}

/** Un renglón ya leído del comprobante, para que el modelo sepa qué buscar. */
export type RenglonParaSeries = { orden: number; codigo: string | null; cantidad: string | null }

/** Una unidad leída: el número de serie y la descripción adicional 1. */
export type UnidadLeida = { orden: number; serie: string; adicional1: string }

export type ResultadoSeries =
  | { ok: true; unidades: UnidadLeida[]; usage?: UsoTokens }
  | { ok: false; error: string; usage?: UsoTokens }

/** Cadena vacía en vez de null, como los otros schemas (ver lib/campos.ts). */
function schemaSeries(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      renglones: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            orden: { type: 'number' },
            unidades: {
              type: 'array',
              items: {
                type: 'object',
                properties: { serie: { type: 'string' }, adicional1: { type: 'string' } },
                required: ['serie', 'adicional1'],
                additionalProperties: false,
              },
            },
          },
          required: ['orden', 'unidades'],
          additionalProperties: false,
        },
      },
    },
    required: ['renglones'],
    additionalProperties: false,
  }
}

export function armarPromptSeries(renglones: RenglonParaSeries[], regla: ReglaSeries): string {
  const lista = renglones
    .map((r) => `${r.orden}. código ${r.codigo ?? '(sin código)'}, cantidad ${r.cantidad ?? '?'}`)
    .join('\n')
  return `Sos un asistente de cuentas a pagar. Te paso un comprobante de compra
de unidades que llevan número de serie (por ejemplo motos) y la lista de
sus renglones, ya leídos:

${lista}

Cada renglón trae, a la derecha o debajo, UNA LÍNEA POR UNIDAD con dos
columnas: "${regla.columnaSerie}" y "${regla.columnaAdicional1}". Un renglón
de cantidad 4 tiene cuatro líneas de unidades, aunque el código, la
descripción y los importes figuren solo en la primera.

Para cada renglón de la lista devolvé su número en "orden" y en "unidades"
una entrada por cada unidad, en el orden impreso:
- "serie": lo de la columna "${regla.columnaSerie}".
- "adicional1": lo de la columna "${regla.columnaAdicional1}".

Reglas:
1. Copiá cada valor EXACTAMENTE como está impreso, con sus espacios
   internos ("162FMJ T3150343"). No corrijas ni completes nada.
2. Las unidades que están debajo de un renglón y antes del siguiente son de
   ese renglón. La cantidad del renglón te dice cuántas tiene que haber:
   usala para controlarte, pero si están impresas menos, devolvé las que
   están. No inventes unidades.
3. Ignorá las marcas de control, tildes o puntos escritos a mano al lado
   de los valores: no son parte del dato.
4. Si un valor no se lee, dejalo vacío.`
}

function texto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Tolerante: una unidad sin serie no sirve y se descarta. */
export function parsearSeries(crudo: string): UnidadLeida[] {
  const json = JSON.parse(crudo) as Record<string, unknown>
  const salida: UnidadLeida[] = []
  for (const r of Array.isArray(json.renglones) ? json.renglones : []) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const orden = Math.trunc(Number(o.orden))
    if (!Number.isFinite(orden) || orden <= 0) continue
    for (const u of Array.isArray(o.unidades) ? o.unidades : []) {
      if (u === null || typeof u !== 'object') continue
      const x = u as Record<string, unknown>
      const serie = texto(x.serie)
      if (!serie) continue
      salida.push({ orden, serie, adicional1: texto(x.adicional1) })
    }
  }
  return salida
}

/** No lanza: una falla acá no tumba la lectura del remito, que ya salió bien. */
export async function extraerSeries(
  pdf: Buffer,
  renglones: RenglonParaSeries[],
  regla: ReglaSeries,
): Promise<ResultadoSeries> {
  if (renglones.length === 0) return { ok: true, unidades: [] }
  let usage: UsoTokens | undefined
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: schemaSeries() } },
      system: [{ type: 'text', text: armarPromptSeries(renglones, regla) }],
      messages: [
        {
          role: 'user',
          content: [bloqueComprobante(pdf), { type: 'text', text: 'Leé las unidades de cada renglón.' }],
        },
      ],
    })
    usage = usoDeRespuesta(r.usage)
    if (r.stop_reason === 'refusal') {
      return { ok: false, error: 'El modelo no procesó los números de serie.', usage }
    }
    const bloque = r.content.find((b) => b.type === 'text')
    if (!bloque || bloque.type !== 'text') {
      return { ok: false, error: 'La lectura de números de serie no trajo texto.', usage }
    }
    return { ok: true, unidades: parsearSeries(bloque.text), usage }
  } catch (err) {
    console.error('extraerSeries: fallo la lectura de numeros de serie:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err), usage }
  }
}
