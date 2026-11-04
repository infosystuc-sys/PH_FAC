import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { camposIaPara } from '@/lib/campos'
import { CAMPOS_NO_ANALIZADOS, TIPOS_FACTURA } from '@/lib/tipoFactura'

// `extraerDePdf` llama al SDK de Anthropic de verdad; se mockea la clase
// entera para poder ejercitarla sin pegarle a la API real (mismo criterio
// que pide la suite: corre igual con ANTHROPIC_API_KEY vacía). `vi.mock` se
// hoistea por encima de los imports de abajo, así que el import estático
// de `@/server/ia/extraccion` ya recibe la version mockeada del SDK.
const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { parsearRespuesta, parsearRenglones, extraerDePdf } from '@/server/ia/extraccion'

const OK = readFileSync('tests/fixtures/extraccion-ok.json', 'utf8')

describe('parsearRespuesta', () => {
  it('parsea una respuesta valida', () => {
    const e = parsearRespuesta(OK, 'articulos')
    expect(e.campos.cuit.valor).toBe('30-71042636-9')
    expect(e.campos.cuit.confianza).toBeCloseTo(0.99)
  })

  it('devuelve exactamente los campos que ese tipo analiza', () => {
    const e = parsearRespuesta(OK, 'articulos')
    expect(Object.keys(e.campos).sort()).toEqual(camposIaPara('articulos').map((c) => c.clave).sort())
  })

  it('conserva el null de un campo que no figura en el PDF', () => {
    const sinDato = JSON.parse(OK)
    sinDato.valores.exento = ''
    expect(parsearRespuesta(JSON.stringify(sinDato), 'articulos').campos.exento.valor).toBeNull()
  })

  it('descarta claves que no estan en el catalogo', () => {
    const conBasura = JSON.parse(OK)
    conBasura.valores.inventado = 'x'
    conBasura.confianzas.inventado = 1
    const e = parsearRespuesta(JSON.stringify(conBasura), 'articulos')
    expect(e.campos).not.toHaveProperty('inventado')
  })

  it('completa con null un campo que la IA omitio', () => {
    const incompleto = JSON.parse(OK)
    delete incompleto.valores.exento
    delete incompleto.confianzas.exento
    const e = parsearRespuesta(JSON.stringify(incompleto), 'articulos')
    expect(e.campos.exento).toEqual({ valor: null, confianza: 0 })
  })

  it('acota la confianza al rango 0..1', () => {
    const fuera = JSON.parse(OK)
    fuera.confianzas.total = 4.2
    expect(parsearRespuesta(JSON.stringify(fuera), 'articulos').campos.total.confianza).toBe(1)
  })

  it('lanza con JSON invalido', () => {
    expect(() => parsearRespuesta('{ esto no es json', 'articulos')).toThrow()
  })

  it('lanza cuando falta el objeto valores', () => {
    expect(() => parsearRespuesta('{"renglones":[]}', 'articulos')).toThrow(/valores/i)
  })

  it('no lanza cuando falta el objeto confianzas: un valor sin confianza sigue siendo util', () => {
    const sinConfianzas = JSON.parse(OK)
    delete sinConfianzas.confianzas
    const e = parsearRespuesta(JSON.stringify(sinConfianzas), 'articulos')
    expect(e.campos.cuit.valor).toBe('30-71042636-9')
    expect(e.campos.cuit.confianza).toBe(0)
  })

})

describe('parsearRenglones', () => {
  // Ningun tipo pide renglones hoy (ver ANALIZA_RENGLONES), pero el parseo
  // sigue probado: activar un tipo es cambiar un false por true, y ahi esta
  // rama vuelve a correr contra comprobantes reales.
  it('lee los cinco datos de cada renglon', () => {
    const r = parsearRenglones(JSON.parse(OK).renglones)
    expect(r).toHaveLength(1)
    expect(r[0].codigo).toBe('106817')
  })

  it('ignora renglones enteramente vacios', () => {
    const conVacio = [
      ...JSON.parse(OK).renglones,
      { codigo: null, descripcion: null, cantidad: null, precioUnitario: null, importe: null },
    ]
    expect(parsearRenglones(conVacio)).toHaveLength(1)
  })

  it('tolera que no sea un array', () => {
    expect(parsearRenglones(undefined)).toEqual([])
    expect(parsearRenglones('no soy un array')).toEqual([])
  })
})

describe('extraerDePdf', () => {
  it('propaga el usage de la respuesta de la API, caché incluida', async () => {
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: OK }],
      usage: {
        input_tokens: 12345,
        output_tokens: 678,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: null,
      },
    })

    const r = await extraerDePdf(Buffer.from('%PDF-1.4 fake'), 'conceptos')

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.usage).toEqual({ entrada: 12345, salida: 678, cacheLectura: 3000, cacheEscritura: 0 })
  })

  it('devuelve el usage tambien cuando la respuesta llega pero no sirve', async () => {
    // Un rechazo o un JSON roto se cobran igual: tienen que poder contarse.
    mockCreate.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'esto no es JSON' }],
      usage: { input_tokens: 100, output_tokens: 20 },
    })

    const r = await extraerDePdf(Buffer.from('%PDF-1.4 fake'), 'conceptos')

    expect(r.ok).toBe(false)
    expect(r.usage).toEqual({ entrada: 100, salida: 20, cacheLectura: 0, cacheEscritura: 0 })
  })

  it('no lanza y devuelve ok:false si la llamada a la API falla', async () => {
    mockCreate.mockRejectedValueOnce(new Error('fallo de red simulado'))

    const r = await extraerDePdf(Buffer.from('%PDF-1.4 fake'), 'conceptos')

    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/fallo de red simulado/)
    expect(r.usage).toBeUndefined()
  })
})

describe('parsearRespuesta por tipo de comprobante', () => {
  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'en %s se descartan los renglones aunque el modelo los mande',
    (tipo) => {
      // El schema no los pide en ningun tipo, asi que esto no deberia pasar.
      // Se descartan igual: un detalle que no se imputa no tiene que llegar a
      // PHF_RENGLON por un error del modelo.
      const conRenglones = {
        ...JSON.parse(OK),
        renglones: [{ codigo: 'X', descripcion: 'Abono', cantidad: '1', precioUnitario: '100', importe: '100' }],
      }
      expect(parsearRespuesta(JSON.stringify(conRenglones), tipo).renglones).toHaveLength(0)
    },
  )

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'en %s no devuelve los campos que no se le pidieron',
    (tipo) => {
      const e = parsearRespuesta(OK, tipo)
      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(e.campos[excluido], `${excluido} no deberia estar`).toBeUndefined()
      }
      // Los que si se piden siguen llegando.
      expect(e.campos.cuit).toBeDefined()
      // Un remito no tiene importes: el total no se le pide.
      if (tipo !== 'remito') expect(e.campos.total).toBeDefined()
    },
  )
})
