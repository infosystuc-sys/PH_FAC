import Anthropic from '@anthropic-ai/sdk'
import { bloqueComprobante } from './extraccion'
import { usoDeRespuesta, type UsoTokens } from '@/lib/usoIa'

/**
 * Lectura de la tabla de certificados del mail del proveedor (2026-11-18,
 * pedido del usuario: el archivo llega como PDF o imagen del mail). IMSA
 * manda "Detalles de Certificados Nacionales" con las columnas MODELO, NRO
 * MOTOR, NRO DE CHASIS, MARCA, NRO DNRPA y NRO CERTIFICADO. Lo que se usa es
 * el chasis (la serie en Tango) y el DNRPA; el motor y el modelo se piden
 * para mostrarlos en la vista previa, que es donde el operador coteja.
 */

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

let cliente: Anthropic | null = null
function getCliente(): Anthropic {
  if (!cliente) cliente = new Anthropic()
  return cliente
}

export type FilaDnrpaLeida = { modelo: string; motor: string; chasis: string; dnrpa: string }

export type ResultadoLecturaDnrpa =
  | { ok: true; filas: FilaDnrpaLeida[]; usage?: UsoTokens }
  | { ok: false; error: string; usage?: UsoTokens }

const SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    filas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          modelo: { type: 'string' },
          motor: { type: 'string' },
          chasis: { type: 'string' },
          dnrpa: { type: 'string' },
        },
        required: ['modelo', 'motor', 'chasis', 'dnrpa'],
        additionalProperties: false,
      },
    },
  },
  required: ['filas'],
  additionalProperties: false,
}

export const PROMPT_DNRPA = `Sos un asistente de cuentas a pagar. Te paso un mail (en PDF o en imagen)
de un proveedor de motos con una tabla de certificados: una fila por unidad,
con columnas como MODELO, NRO MOTOR, NRO DE CHASIS, MARCA, NRO DNRPA y NRO
CERTIFICADO.

Devolvé en "filas" una entrada por cada fila de la tabla, en el orden impreso:
- "modelo": lo de la columna MODELO.
- "motor": lo de la columna NRO MOTOR.
- "chasis": lo de la columna NRO DE CHASIS.
- "dnrpa": lo de la columna NRO DNRPA (por ejemplo "M-0000903599/2026").

Reglas:
1. Copiá cada valor EXACTAMENTE como está impreso. No corrijas ni completes
   nada. El chasis suele tener 17 caracteres (letras y números, sin I, O ni Q).
2. Un valor partido en dos líneas dentro de la misma celda es UN solo valor.
3. No confundas NRO DNRPA con NRO CERTIFICADO: son columnas distintas.
4. Si la tabla sigue en otra página, incluí también esas filas.
5. Si un valor no se lee, dejalo vacío. No inventes filas.`

function texto(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Tolerante: una fila sin chasis ni DNRPA no sirve y se descarta. */
export function parsearDnrpa(crudo: string): FilaDnrpaLeida[] {
  const json = JSON.parse(crudo) as Record<string, unknown>
  const salida: FilaDnrpaLeida[] = []
  for (const f of Array.isArray(json.filas) ? json.filas : []) {
    if (f === null || typeof f !== 'object') continue
    const o = f as Record<string, unknown>
    const fila = { modelo: texto(o.modelo), motor: texto(o.motor), chasis: texto(o.chasis), dnrpa: texto(o.dnrpa) }
    if (!fila.chasis && !fila.dnrpa) continue
    salida.push(fila)
  }
  return salida
}

/** No lanza: la pantalla muestra el error. */
export async function extraerDnrpa(archivo: Buffer): Promise<ResultadoLecturaDnrpa> {
  let usage: UsoTokens | undefined
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: PROMPT_DNRPA }],
      messages: [
        {
          role: 'user',
          content: [bloqueComprobante(archivo), { type: 'text', text: 'Leé la tabla de certificados.' }],
        },
      ],
    })
    usage = usoDeRespuesta(r.usage)
    if (r.stop_reason === 'refusal') return { ok: false, error: 'El modelo no procesó el archivo.', usage }
    const bloque = r.content.find((b) => b.type === 'text')
    if (!bloque || bloque.type !== 'text') return { ok: false, error: 'La lectura no trajo texto.', usage }
    return { ok: true, filas: parsearDnrpa(bloque.text), usage }
  } catch (err) {
    console.error('extraerDnrpa: fallo la lectura del archivo de DNRPA:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err), usage }
  }
}
