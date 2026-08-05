import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsearRespuesta } from '@/server/ia/extraccion'
import { CAMPOS_IA } from '@/lib/campos'

const OK = readFileSync('tests/fixtures/extraccion-ok.json', 'utf8')

describe('parsearRespuesta', () => {
  it('parsea una respuesta valida', () => {
    const e = parsearRespuesta(OK)
    expect(e.campos.cuit.valor).toBe('30-71042636-9')
    expect(e.campos.cuit.confianza).toBeCloseTo(0.99)
    expect(e.renglones).toHaveLength(1)
    expect(e.renglones[0].codigo).toBe('106817')
  })

  it('devuelve los 21 campos del catalogo', () => {
    const e = parsearRespuesta(OK)
    expect(Object.keys(e.campos).sort()).toEqual(CAMPOS_IA.map((c) => c.clave).sort())
  })

  it('conserva el null de un campo que no figura en el PDF', () => {
    expect(parsearRespuesta(OK).campos.ordencompra.valor).toBeNull()
  })

  it('descarta claves que no estan en el catalogo', () => {
    const conBasura = JSON.parse(OK)
    conBasura.campos.inventado = { valor: 'x', confianza: 1 }
    const e = parsearRespuesta(JSON.stringify(conBasura))
    expect(e.campos).not.toHaveProperty('inventado')
  })

  it('completa con null un campo que la IA omitio', () => {
    const incompleto = JSON.parse(OK)
    delete incompleto.campos.cae
    const e = parsearRespuesta(JSON.stringify(incompleto))
    expect(e.campos.cae).toEqual({ valor: null, confianza: 0 })
  })

  it('acota la confianza al rango 0..1', () => {
    const fuera = JSON.parse(OK)
    fuera.campos.total.confianza = 4.2
    expect(parsearRespuesta(JSON.stringify(fuera)).campos.total.confianza).toBe(1)
  })

  it('lanza con JSON invalido', () => {
    expect(() => parsearRespuesta('{ esto no es json')).toThrow()
  })

  it('lanza cuando falta el objeto campos', () => {
    expect(() => parsearRespuesta('{"renglones":[]}')).toThrow(/campos/i)
  })

  it('ignora renglones enteramente vacios', () => {
    const conVacio = JSON.parse(OK)
    conVacio.renglones.push({
      codigo: null, descripcion: null, cantidad: null,
      precioUnitario: null, importe: null,
    })
    expect(parsearRespuesta(JSON.stringify(conVacio)).renglones).toHaveLength(1)
  })
})
