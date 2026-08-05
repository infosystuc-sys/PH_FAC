import { describe, it, expect } from 'vitest'
import { formatMoneda, formatFecha, formatCuit, normalizarCuit } from '@/lib/formato'

describe('formatMoneda', () => {
  it('formatea con separador de miles y dos decimales', () => {
    expect(formatMoneda(1234567.89)).toBe('$ 1.234.567,89')
  })

  it('muestra guion cuando es cero', () => {
    expect(formatMoneda(0)).toBe('—')
  })

  it('muestra guion cuando es null', () => {
    expect(formatMoneda(null)).toBe('—')
  })

  it('redondea a dos decimales', () => {
    expect(formatMoneda(10.005)).toBe('$ 10,01')
  })
})

describe('formatFecha', () => {
  it('formatea como dd/mm/yyyy', () => {
    expect(formatFecha('2026-05-18')).toBe('18/05/2026')
  })

  it('muestra guion cuando es null', () => {
    expect(formatFecha(null)).toBe('—')
  })
})

describe('normalizarCuit', () => {
  it('quita guiones y espacios', () => {
    expect(normalizarCuit('30-64872913-7')).toBe('30648729137')
  })

  it('devuelve null si no quedan 11 digitos', () => {
    expect(normalizarCuit('30-6487')).toBeNull()
  })

  it('devuelve null cuando es null', () => {
    expect(normalizarCuit(null)).toBeNull()
  })
})

describe('formatCuit', () => {
  it('aplica la mascara de Tango', () => {
    expect(formatCuit('30648729137')).toBe('30-64872913-7')
  })

  it('devuelve el original si no son 11 digitos', () => {
    expect(formatCuit('123')).toBe('123')
  })

  it('muestra guion cuando es null', () => {
    expect(formatCuit(null)).toBe('—')
  })
})
