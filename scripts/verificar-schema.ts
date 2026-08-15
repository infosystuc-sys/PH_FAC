/**
 * Le manda a la API el JSON Schema de cada tipo de comprobante y avisa si
 * entra.
 *
 * Structured outputs compila el schema a una gramática que restringe,
 * token por token, lo que el modelo puede escribir. Esa compilación tiene
 * un límite de tamaño, y arriba del límite la API devuelve 400 "compiled
 * grammar is too large" ANTES de mirar el PDF. Ningún test de la suite
 * puede detectarlo: verifican que armemos bien el schema, no que la API lo
 * acepte. Este script es la única forma de saberlo sin importar un
 * comprobante de verdad.
 *
 * Corré esto cada vez que se agreguen campos al catálogo. Ya pasó que el
 * catálogo creciera de 29 a 39 campos y NINGÚN tipo se pudiera importar,
 * sin que nada lo señalara.
 *
 * Cuesta tres requests mínimos, sin PDF: la gramática se compila igual.
 *
 *   pnpm tsx scripts/verificar-schema.ts
 *   pnpm tsx scripts/verificar-schema.ts --techo   # ademas busca el maximo
 */
import { config as cargarEnv } from 'dotenv'
cargarEnv({ path: '.env.local' })

import Anthropic from '@anthropic-ai/sdk'
import { CAMPOS_IA, camposIaPara, schemaExtraccion } from '../src/lib/campos'
import { CLAVES_RENGLON } from '../src/lib/renglones'
import {
  TIPOS_FACTURA,
  ANALIZA_RENGLONES,
  MAX_CAMPOS_SIN_RENGLONES,
  MAX_CAMPOS_CON_RENGLONES,
} from '../src/lib/tipoFactura'

const cliente = new Anthropic()
const MODELO = process.env.ANTHROPIC_MODELO || 'claude-opus-5'

/** Un request mínimo que igual obliga a compilar la gramática. */
async function aceptaSchema(schema: Record<string, unknown>): Promise<string | null> {
  try {
    await cliente.messages.create({
      model: MODELO,
      max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'Devolvé todos los campos vacíos.' }],
    })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

const VALOR = { type: 'string' }
const objeto = (p: Record<string, unknown>) => ({
  type: 'object',
  properties: p,
  required: Object.keys(p),
  additionalProperties: false,
})

/** Un schema de `n` campos, para medir el techo sin depender del catálogo. */
function schemaDePrueba(n: number, conRenglones: boolean) {
  const valores: Record<string, unknown> = {}
  const confianzas: Record<string, unknown> = {}
  for (const x of CAMPOS_IA.slice(0, n)) {
    valores[x.clave] = VALOR
    confianzas[x.clave] = { type: 'number' }
  }
  const props: Record<string, unknown> = {
    valores: objeto(valores),
    confianzas: objeto(confianzas),
  }
  if (conRenglones) {
    const r: Record<string, unknown> = {}
    for (const k of CLAVES_RENGLON) r[k] = VALOR
    props.renglones = { type: 'array', items: objeto(r) }
  }
  return objeto(props)
}

/** Bisección sobre la cantidad de campos que la API todavía acepta. */
async function buscarTecho(conRenglones: boolean): Promise<number> {
  let ok = 1
  let no = CAMPOS_IA.length + 1
  if ((await aceptaSchema(schemaDePrueba(CAMPOS_IA.length, conRenglones))) === null) {
    return CAMPOS_IA.length
  }
  while (no - ok > 1) {
    const medio = Math.floor((ok + no) / 2)
    if ((await aceptaSchema(schemaDePrueba(medio, conRenglones))) === null) ok = medio
    else no = medio
  }
  return ok
}

async function main() {
  let fallo = false

  for (const t of TIPOS_FACTURA) {
    const campos = camposIaPara(t.clave).length
    const conR = ANALIZA_RENGLONES[t.clave]
    const techo = conR ? MAX_CAMPOS_CON_RENGLONES : MAX_CAMPOS_SIN_RENGLONES
    const error = await aceptaSchema(schemaExtraccion(t.clave))

    const detalle = `${String(campos).padStart(2)} campos, ${conR ? 'con' : 'sin'} renglones (techo ${techo})`
    if (error) {
      fallo = true
      console.log(`FALLA  ${t.clave.padEnd(10)} ${detalle}`)
      console.log(`       ${error.slice(0, 300)}`)
    } else {
      console.log(`OK     ${t.clave.padEnd(10)} ${detalle}`)
    }
  }

  if (process.argv.includes('--techo')) {
    console.log('\nMidiendo el techo por biseccion (varios requests, tarda):')
    for (const conR of [false, true]) {
      const techo = await buscarTecho(conR)
      const anotado = conR ? MAX_CAMPOS_CON_RENGLONES : MAX_CAMPOS_SIN_RENGLONES
      const marca = techo === anotado ? 'igual al anotado' : `DISTINTO del anotado (${anotado})`
      console.log(`  ${conR ? 'con' : 'sin'} renglones: ${techo} campos -- ${marca}`)
    }
  }

  if (fallo) {
    console.log('\nHay al menos un tipo que no se puede importar. Sacá campos del')
    console.log('catalogo (CAMPOS_NO_ANALIZADOS en src/lib/tipoFactura.ts) hasta que entre.')
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
