import { describe, it, expect } from 'vitest'
import {
  formatMoneda,
  formatCantidad,
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

describe('formatCantidad', () => {
  it('formatea con separador es-AR, sin el signo $', () => {
    expect(formatCantidad(1234.5)).toBe('1.234,50')
  })

  it('a diferencia de formatMoneda, cero no es guion', () => {
    // Una cantidad de 0 no es "sin dato" como sí lo es un importe de $0.
    expect(formatCantidad(0)).toBe('0,00')
  })

  it('muestra guion cuando es null', () => {
    expect(formatCantidad(null)).toBe('—')
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

  it('ignora el simbolo de moneda', () => {
    // AMX (Claro) imprime "$534.043,77". Hasta el 2026-10-10 eso daba NaN y
    // caia a 0: el total del comprobante y sus tres importes de IVA
    // quedaban en cero, y la pantalla no reconocia ningun impuesto.
    expect(parsearImporte('$534.043,77')).toBeCloseTo(534043.77, 2)
    expect(parsearImporte('$ 26.605,85')).toBeCloseTo(26605.85, 2)
  })

  it('ignora tambien los simbolos de varios caracteres', () => {
    // Van antes que el "$" al limpiar: sacarle el signo a "U$S 1.234"
    // dejaria "US1.234", que ya no es un numero.
    expect(parsearImporte('U$S 1.234,56')).toBeCloseTo(1234.56, 2)
    expect(parsearImporte('USD 1.234,56')).toBeCloseTo(1234.56, 2)
    expect(parsearImporte('1.234,56 ARS')).toBeCloseTo(1234.56, 2)
  })

  it('conserva el signo negativo aunque venga con moneda', () => {
    // SPRINGWALL factura la bonificacion en negativo.
    expect(parsearImporte('-108.805,79')).toBeCloseTo(-108805.79, 2)
    expect(parsearImporte('$-108.805,79')).toBeCloseTo(-108805.79, 2)
  })

  it('NO saca un numero de un texto cualquiera', () => {
    // Es el limite de lo anterior: si se quitara todo lo que no es digito,
    // "Iva Percepcion 3%" daria 3 y "Factura 1234" daria 1234. Un importe
    // inventado entra al asiento sin que nadie lo note, asi que lo que no
    // tiene forma de numero se declara ilegible.
    expect(parsearImporteONulo('Iva Percepción 3%')).toBeNull()
    expect(parsearImporteONulo('Factura 1234')).toBeNull()
    expect(parsearImporteONulo('abc')).toBeNull()
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

  it('un punto con 1 digito detras es decimal (formato ingles de un solo decimal)', () => {
    expect(parsearImporte('2.5')).toBeCloseTo(2.5, 4)
  })

  it('un punto con 4 o mas digitos detras es decimal, no separador de miles', () => {
    expect(parsearImporte('12.3456')).toBeCloseTo(12.3456, 4)
  })

  it('un punto con exactamente 3 digitos detras es ambiguo y se resuelve como miles', () => {
    // "1.234" podria ser 1234 (miles) o 1,234 (decimal). Se elige miles: es
    // la lectura mas comun en los importes de las facturas reales, y un
    // decimal de exactamente 3 cifras es un caso raro.
    expect(parsearImporte('1.234')).toBeCloseTo(1234, 2)
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
