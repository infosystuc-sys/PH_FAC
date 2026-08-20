import Anthropic from '@anthropic-ai/sdk'
import type { LineaRemito, RenglonFacturado } from '@/lib/cotejo'

/**
 * Segunda pasada de extracción: lee los renglones de una factura de
 * artículos y los empareja con los del remito.
 *
 * Va en un llamado aparte del de la cabecera por dos razones, y las dos
 * importan:
 *
 * 1. El schema no entra de otra forma. Structured outputs compila el
 *    schema a una gramática con un techo de tamaño medido (35 campos sin
 *    el array de renglones, 31 con él). Artículos ya usa 33 campos de
 *    cabecera, así que el array no cabe en el mismo request. Acá el schema
 *    es mínimo -- cuatro campos por renglón -- y sobra lugar.
 *
 * 2. Recién en la segunda pasada se sabe qué trae el remito. La cabecera
 *    da el NÚMERO de remito; con eso la app va a STA20 y consigue los
 *    artículos y las cantidades. Esa lista se le pasa al modelo acá, y el
 *    emparejamiento lo hace él. Es el único camino que funciona: la
 *    equivalencia entre el código del proveedor y el nuestro está cargada
 *    en 539 de 9.154 artículos (CPA15), así que emparejar por código no
 *    sirve, y el modelo sí sabe que "ZAPATILLA FILA RENNO CLASSIC
 *    MASCULINO" es el mismo artículo que nuestra descripción.
 */

const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

let cliente: Anthropic | null = null
function getCliente(): Anthropic {
  if (!cliente) cliente = new Anthropic()
  return cliente
}

export type ResultadoRenglones =
  | { ok: true; renglones: RenglonFacturado[]; ms: number }
  | { ok: false; error: string }

/**
 * Misma convención que el schema de la cabecera: cadena vacía en vez de
 * null, y sin uniones de tipos. Las dos cosas vienen de rechazos reales de
 * la API -- ver el comentario de `schemaExtraccion` en lib/campos.ts.
 *
 * `lineaRemito` es number y usa 0 para "no está en el remito", en vez de
 * null, por lo mismo: un `anyOf` de number|null sumaría una unión.
 */
function schemaRenglones(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      renglones: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lineaRemito: { type: 'number' },
            descripcion: { type: 'string' },
            cantidad: { type: 'string' },
            precioUnitario: { type: 'string' },
          },
          required: ['lineaRemito', 'descripcion', 'cantidad', 'precioUnitario'],
          additionalProperties: false,
        },
      },
    },
    required: ['renglones'],
    additionalProperties: false,
  }
}

/**
 * El prompt lleva los renglones del remito numerados. El modelo no tiene
 * que adivinar códigos: elige de una lista cerrada y corta (3,8 renglones
 * por remito en promedio, 50 el máximo).
 */
function armarPrompt(lineas: LineaRemito[]): string {
  const detalle = lineas
    .map(
      (l) =>
        `${l.indice}. ${l.codArticulo} — ${l.descripcion ?? 'sin descripción'} ` +
        `(remito ${l.numeroRemito}, cantidad entregada ${l.cantidad})`,
    )
    .join('\n')

  return `Sos un asistente de cuentas a pagar. Te paso una factura de compra de
artículos y la lista de la mercadería que el proveedor entregó según el
remito. Tenés que leer los renglones de la factura y decir a qué renglón
del remito corresponde cada uno.

La mercadería entregada según el remito es:

${detalle}

Reglas:

1. Devolvé un renglón por cada línea de artículo de la factura, en el orden
   en que aparecen. No agrupes ni sumes líneas.

2. ATENCIÓN CON LOS TALLES. En calzado e indumentaria el remito viene
   abierto por talle -- un renglón por cada uno -- y la factura suele traer
   una sola línea por artículo con el detalle de talles adentro, del estilo
   "270: 4  280: 4  290: 6" o "27:4 28:4 29:6", y una cantidad total.
   Cuando veas ese desglose, devolvé UNA LÍNEA POR TALLE, no una por
   artículo: cada una con su lineaRemito y con la cantidad de ESE talle,
   nunca el total de la línea impresa.

   Ejemplo. Si la factura imprime

       025873 001 GRAF KIDS   270: 4  280: 4  310: 6      34,00

   y en la lista de arriba están los renglones "25873  001 27" (cantidad
   4), "25873  001 28" (4) y "25873  001 31" (6), tenés que devolver tres
   renglones: uno con cantidad "4" apuntando al primero, otro con "4"
   apuntando al segundo y otro con "6" apuntando al tercero. El 34 no se
   devuelve en ningún lado.

   El precio unitario de la línea impresa se repite en cada talle: es el
   mismo artículo.

   Si la factura NO desglosa talles, devolvé la línea tal cual, una sola.

3. En lineaRemito va el NÚMERO de la lista de arriba al que corresponde esa
   línea de la factura. Emparejá por lo que se está vendiendo: la
   descripción del proveedor casi nunca coincide palabra por palabra con la
   nuestra, y su código de artículo suele ser distinto del nuestro.

4. Si una línea de la factura no corresponde a ninguno de los artículos de
   la lista, poné lineaRemito en 0. Es lo que hay que hacer con fletes,
   bonificaciones, cargos por servicio y cualquier concepto que no sea
   mercadería del remito. No la fuerces al artículo más parecido: un 0 es
   un dato correcto, un emparejamiento inventado no.

5. cantidad y precioUnitario van EXACTAMENTE como figuran impresos, sin
   normalizar: si dice "1.200,50" devolvé "1.200,50". El precio unitario es
   el de la línea antes de impuestos; si la factura no lo muestra, dejalo
   vacío.

6. En descripcion va la descripción tal como la imprime el proveedor, no la
   nuestra. Si desglosaste por talle, agregale el talle al final para que
   el operador sepa cuál de las líneas es.

7. No inventes renglones que no estén impresos, y no omitas ninguno: si un
   artículo de la lista no aparece en la factura, simplemente no va a tener
   ninguna línea que lo señale. Eso lo detecta la app, no vos.`
}

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t === '' ? null : t
}

/** Tolerante a propósito, igual que `parsearRespuesta` de la cabecera. */
export function parsearRenglonesFacturados(crudo: string): RenglonFacturado[] {
  const json = JSON.parse(crudo) as Record<string, unknown>
  const lista = Array.isArray(json.renglones) ? json.renglones : []

  const salida: RenglonFacturado[] = []
  for (const r of lista) {
    if (r === null || typeof r !== 'object') continue
    const o = r as Record<string, unknown>

    const cantidad = texto(o.cantidad)
    const descripcion = texto(o.descripcion)
    // Un renglon sin cantidad ni descripcion no es un renglon.
    if (cantidad === null && descripcion === null) continue

    const n = Number(o.lineaRemito)
    salida.push({
      lineaRemito: Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0,
      descripcion,
      cantidad,
      precioUnitario: texto(o.precioUnitario),
    })
  }
  return salida
}

/**
 * No lanza: toda falla vuelve como `{ ok: false }`. Una segunda pasada que
 * falla no puede tumbar la extracción de la cabecera, que ya salió bien --
 * el comprobante se revisa igual, solo que sin el cotejo.
 */
export async function extraerRenglonesFacturados(
  pdf: Buffer,
  lineas: LineaRemito[],
): Promise<ResultadoRenglones> {
  if (lineas.length === 0) return { ok: true, renglones: [], ms: 0 }

  const arranque = Date.now()
  try {
    const r = await getCliente().messages.create({
      model: MODELO,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: schemaRenglones() },
      },
      // Sin cache_control: el prompt lleva los renglones de ESTE remito, así
      // que cambia en cada comprobante y no hay prefijo estable que cachear.
      system: [{ type: 'text', text: armarPrompt(lineas) }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
            },
            { type: 'text', text: 'Leé los renglones de esta factura.' },
          ],
        },
      ],
    })

    if (r.stop_reason === 'refusal') {
      return { ok: false, error: 'El modelo no procesó los renglones del comprobante.' }
    }

    const bloque = r.content.find((b) => b.type === 'text')
    if (!bloque || bloque.type !== 'text') {
      return { ok: false, error: 'La respuesta de renglones no trajo contenido de texto.' }
    }

    return {
      ok: true,
      renglones: parsearRenglonesFacturados(bloque.text),
      ms: Date.now() - arranque,
    }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    console.error(`extraerRenglonesFacturados[${arranque}]: fallo la segunda pasada:`, err)
    return { ok: false, error: mensaje.slice(0, 900) }
  }
}
