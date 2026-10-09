import { describe, it, expect } from 'vitest'
import {
  conciliar,
  resumir,
  partirNComp,
  claseDeTcomp,
  type FilaArca,
  type FilaTango,
} from '@/lib/conciliacion'

const SIN_PERIODO = { desde: null, hasta: null }

function enArca(p: Partial<FilaArca> = {}): FilaArca {
  return {
    id: 1,
    fechaEmision: new Date(2026, 8, 16),
    letra: 'A',
    clase: 'factura',
    puntoVenta: 214,
    numero: 4214,
    cuitEmisor: '30500525327',
    razonEmisor: 'TOPPER ARGENTINA S.A.',
    importeTotal: 153138.5,
    ...p,
  }
}

function enTango(p: Partial<FilaTango> = {}): FilaTango {
  return {
    tipo: 'FAC',
    nComp: 'A0021400004214',
    codProvee: '010089',
    cuitProveedor: '30500525327',
    razonProveedor: 'TOPPER ARGENTINA S.A.',
    fechaEmision: new Date(2026, 8, 16),
    importeTotal: 153138.5,
    ...p,
  }
}

describe('partirNComp', () => {
  // Los tres formatos conviven en la base: medido sobre las 17.483 filas
  // el 2026-10-09. Los ejemplos son reales.
  it('letra + punto de venta(5) + numero(8)', () => {
    expect(partirNComp('A0021400004214')).toEqual({ puntoVenta: 214, numero: 4214 })
    expect(partirNComp('C0000300000027')).toEqual({ puntoVenta: 3, numero: 27 })
  })

  it('punto de venta(5) + GUION + numero(8)', () => {
    // JUAREZ CARLOS RODOLFO, TELECOM. Partirlo por posiciones fijas leía
    // mal estos cientos de filas.
    expect(partirNComp('00005-00004889')).toEqual({ puntoVenta: 5, numero: 4889 })
    expect(partirNComp('03950-07852501')).toEqual({ puntoVenta: 3950, numero: 7852501 })
  })

  it('punto de venta(6) + numero(8), sin letra ni guion', () => {
    // COPPENS, nota de credito 0017-00002540.
    expect(partirNComp('00001700002540')).toEqual({ puntoVenta: 17, numero: 2540 })
  })

  it('aguanta el espacio de relleno adelante', () => {
    expect(partirNComp(' 0000050000713')).toEqual({ puntoVenta: 0, numero: 50000713 })
  })

  it('rechaza lo que no tiene forma de N_COMP', () => {
    expect(partirNComp('A001')).toBeNull()
    expect(partirNComp('')).toBeNull()
    // Sin nada antes del numero no hay punto de venta que leer.
    expect(partirNComp('00004214')).toBeNull()
  })
})

describe('claseDeTcomp', () => {
  it('NC1 y NC2 son las dos una nota de crédito', () => {
    // ARCA no informa esa diferencia: para el cruce son lo mismo.
    expect(claseDeTcomp('NC1')).toBe('nota-credito')
    expect(claseDeTcomp('NC2')).toBe('nota-credito')
  })

  it('lo que no se reconoce no se fuerza a factura', () => {
    expect(claseDeTcomp('O/P')).toBe('otro')
    expect(claseDeTcomp('')).toBe('otro')
  })
})

describe('conciliar', () => {
  it('empareja el mismo comprobante en los dos lados', () => {
    const r = conciliar([enArca()], [enTango()], SIN_PERIODO)
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('coincide')
  })

  it('marca el que ARCA informa y en Tango no está', () => {
    const r = conciliar([enArca()], [], SIN_PERIODO)
    expect(r[0].estado).toBe('falta-en-tango')
    expect(r[0].tango).toBeNull()
  })

  it('busca en TODO Tango, aunque la fecha no coincida', () => {
    // Es el motivo de comparar contra todo: un comprobante cargado con la
    // fecha equivocada está cargado igual, y marcarlo como faltante haría
    // que lo carguen dos veces.
    const r = conciliar(
      [enArca({ fechaEmision: new Date(2026, 8, 16) })],
      [enTango({ fechaEmision: new Date(2024, 0, 2) })],
      SIN_PERIODO,
    )
    expect(r[0].estado).toBe('coincide')
  })

  it('marca la diferencia de importe', () => {
    const r = conciliar([enArca({ importeTotal: 153138.5 })], [enTango({ importeTotal: 150000 })], SIN_PERIODO)
    expect(r[0].estado).toBe('difiere')
    expect(r[0].diferencia).toContain('153138.50')
    expect(r[0].diferencia).toContain('150000.00')
  })

  it('tolera una diferencia de centavos', () => {
    const r = conciliar([enArca({ importeTotal: 153138.5 })], [enTango({ importeTotal: 153138.12 })], SIN_PERIODO)
    expect(r[0].estado).toBe('coincide')
  })

  it('una nota de crédito NO tapa a la factura del mismo número', () => {
    // Medido en la base: hay 15 casos de mismo proveedor y mismo N_COMP con
    // distinto tipo. Sin la clase en la clave, una taparia a la otra.
    const factura = enArca({ id: 1, clase: 'factura', importeTotal: 1000 })
    const notaCredito = enArca({ id: 2, clase: 'nota-credito', importeTotal: 300 })
    const r = conciliar(
      [factura, notaCredito],
      [
        enTango({ tipo: 'FAC', importeTotal: 1000 }),
        enTango({ tipo: 'NC2', importeTotal: 300 }),
      ],
      SIN_PERIODO,
    )
    expect(r.filter((x) => x.estado === 'coincide')).toHaveLength(2)
  })

  it('un comprobante de Tango no se empareja dos veces', () => {
    // Dos filas de ARCA con la misma clave: la segunda queda como faltante,
    // no reusa el mismo comprobante de Tango.
    const r = conciliar([enArca({ id: 1 }), enArca({ id: 2 })], [enTango()], SIN_PERIODO)
    expect(r.filter((x) => x.estado === 'coincide')).toHaveLength(1)
    expect(r.filter((x) => x.estado === 'falta-en-tango')).toHaveLength(1)
  })

  describe('lo que está en Tango y ARCA no informa', () => {
    it('se marca cuando cae dentro del período del archivo', () => {
      const r = conciliar([], [enTango({ fechaEmision: new Date(2026, 8, 16) })], {
        desde: new Date(2026, 8, 1),
        hasta: new Date(2026, 8, 30),
      })
      expect(r[0].estado).toBe('falta-en-arca')
    })

    it('NO se marca si es anterior al período: el archivo no lo cubre', () => {
      // Sin esto, con 16.735 facturas desde 2002 y un archivo de un mes, la
      // pantalla listaria toda la historia como faltante en ARCA.
      const r = conciliar([], [enTango({ fechaEmision: new Date(2020, 0, 5) })], {
        desde: new Date(2026, 8, 1),
        hasta: new Date(2026, 8, 30),
      })
      expect(r).toEqual([])
    })

    it('tampoco si no tiene fecha: no hay con qué ubicarlo', () => {
      const r = conciliar([], [enTango({ fechaEmision: null })], {
        desde: new Date(2026, 8, 1),
        hasta: new Date(2026, 8, 30),
      })
      expect(r).toEqual([])
    })
  })

  it('ignora los comprobantes de Tango con N_COMP ilegible', () => {
    const r = conciliar([enArca()], [enTango({ nComp: 'XX' })], SIN_PERIODO)
    expect(r[0].estado).toBe('falta-en-tango')
  })
})

describe('resumir', () => {
  it('cuenta por estado', () => {
    const filas = conciliar(
      [enArca({ id: 1 }), enArca({ id: 2, numero: 9999 })],
      [enTango()],
      SIN_PERIODO,
    )
    expect(resumir(filas)).toEqual({
      coincide: 1,
      'falta-en-tango': 1,
      'falta-en-arca': 0,
      difiere: 0,
    })
  })
})
