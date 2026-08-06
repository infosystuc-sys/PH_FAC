import { describe, it, expect } from 'vitest'
import {
  formatMoneda,
  formatFecha,
  formatCuit,
  normalizarCuit,
  parsearImporte,
  parsearImporteONulo,
} from '@/lib/formato'

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

describe('parsearImporte', () => {
  // Las dos primeras salieron de un comprobante real (Comprobante_147868-
  // CLARO.pdf): la misma factura imprime el neto sin separador de miles y
  // el IVA en formato argentino, en la misma línea.
  it('un solo punto seguido de 2 digitos es decimal', () => {
    expect(parsearImporte('186623.75')).toBeCloseTo(186623.75, 2)
  })

  it('formato argentino: punto de miles, coma decimal', () => {
    expect(parsearImporte('39.190,99')).toBeCloseTo(39190.99, 2)
  })

  it('punto y coma juntos: el que aparece ultimo es el decimal', () => {
    expect(parsearImporte('322.982,28')).toBeCloseTo(322982.28, 2)
  })

  it('formato ingles: coma de miles, punto decimal', () => {
    expect(parsearImporte('322,982.28')).toBeCloseTo(322982.28, 2)
  })

  it('solo coma es decimal', () => {
    expect(parsearImporte('1234,56')).toBeCloseTo(1234.56, 2)
  })

  it('un punto seguido de 3 digitos es separador de miles, no decimal', () => {
    expect(parsearImporte('186.623')).toBeCloseTo(186623, 2)
  })

  it('varios puntos son siempre separador de miles', () => {
    expect(parsearImporte('1.186.623')).toBeCloseTo(1186623, 2)
  })

  it('sin separadores', () => {
    expect(parsearImporte('484344')).toBeCloseTo(484344, 2)
  })

  it('devuelve 0 cuando no parsea', () => {
    expect(parsearImporte('ilegible')).toBe(0)
  })

  it('devuelve 0 cuando es null o undefined', () => {
    expect(parsearImporte(null)).toBe(0)
    expect(parsearImporte(undefined)).toBe(0)
  })
})

describe('parsearImporteONulo', () => {
  it('devuelve el numero cuando parsea', () => {
    expect(parsearImporteONulo('186623.75')).toBeCloseTo(186623.75, 2)
  })

  it('devuelve null (no 0) cuando no parsea, para no grabar un dato falso', () => {
    expect(parsearImporteONulo('ilegible')).toBeNull()
  })

  it('devuelve null cuando es null o undefined', () => {
    expect(parsearImporteONulo(null)).toBeNull()
    expect(parsearImporteONulo(undefined)).toBeNull()
  })
})
