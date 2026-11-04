import { describe, it, expect } from 'vitest'
import { costoUsd, usoDeRespuesta } from '@/lib/usoIa'

describe('usoDeRespuesta', () => {
  it('pasa los null de cache a 0', () => {
    expect(
      usoDeRespuesta({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null }),
    ).toEqual({ entrada: 10, salida: 5, cacheLectura: 0, cacheEscritura: 0 })
  })

  it('sin usage devuelve undefined', () => {
    expect(usoDeRespuesta(undefined)).toBeUndefined()
  })
})

describe('costoUsd', () => {
  it('cobra cada contador con su tarifa', () => {
    // Opus 5: 5 / 25 / 0,50 / 6,25 USD por millon.
    const c = costoUsd('claude-opus-5', {
      entrada: 1_000_000, salida: 1_000_000, cacheLectura: 1_000_000, cacheEscritura: 1_000_000,
    })
    expect(c).toBeCloseTo(36.75, 6)
  })

  it('un comprobante tipico cuesta centavos', () => {
    const c = costoUsd('claude-opus-5', { entrada: 4000, salida: 2000, cacheLectura: 3000, cacheEscritura: 0 })
    expect(c).toBeCloseTo(0.0715, 6)
  })

  it('un modelo sin tarifa no tiene costo', () => {
    expect(costoUsd('otro-modelo', { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 })).toBeNull()
    expect(costoUsd(null, { entrada: 1, salida: 1, cacheLectura: 0, cacheEscritura: 0 })).toBeNull()
  })
})
