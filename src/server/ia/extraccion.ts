import Anthropic from '@anthropic-ai/sdk'
import { CAMPOS_IA, schemaExtraccion } from '@/lib/campos'
import { CLAVES_RENGLON, type RenglonExtraido } from '@/lib/renglones'
import { PROMPT_EXTRACCION } from './prompt'

export type CampoExtraido = { valor: string | null; confianza: number }

export type Extraccion = {
  campos: Record<string, CampoExtraido>
  renglones: RenglonExtraido[]
}

export type ResultadoExtraccion =
  | { ok: true; extraccion: Extraccion; ms: number; modelo: string }
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
export function parsearRespuesta(texto_: string): Extraccion {
  const crudo = JSON.parse(texto_) as Record<string, unknown>

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
  for (const def of CAMPOS_IA) {
    const valor = texto(dicValores[def.clave])
    campos[def.clave] = {
      valor,
      // Un campo sin valor no aporta confianza al promedio.
      confianza: valor === null ? 0 : confianza(dicConfianzas[def.clave]),
    }
  }

  const renglones: RenglonExtraido[] = []
  for (const r of Array.isArray(crudo.renglones) ? crudo.renglones : []) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const fila = Object.fromEntries(
      CLAVES_RENGLON.map((k) => [k, texto(o[k])]),
    ) as unknown as RenglonExtraido
    // Un renglon sin un solo dato no es un renglon.
    if (CLAVES_RENGLON.every((k) => fila[k] === null)) continue
    renglones.push(fila)
  }

  return { campos, renglones }
}

/**
 * Manda el PDF a Claude y devuelve los campos con su confianza. No lanza:
 * toda falla vuelve como `{ ok: false }` para que la cola decida si
 * reintenta o marca el comprobante en error.
 */
export async function extraerDePdf(pdf: Buffer): Promise<ResultadoExtraccion> {
  const arranque = Date.now()
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 16000,
      // En Opus 5 el pensamiento se cuenta DENTRO de max_tokens.
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: schemaExtraccion() },
      },
      system: [
        {
          type: 'text',
          text: PROMPT_EXTRACCION,
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
      extraccion: parsearRespuesta(bloque.text),
      ms: Date.now() - arranque,
      modelo: MODELO,
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
