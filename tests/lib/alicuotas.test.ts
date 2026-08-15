import { describe, it, expect } from 'vitest'
import { resolverCodigoIva, resolverAlicuotas, type AlicuotaTango } from '@/lib/alicuotas'
import { validarAlicuotas } from '@/lib/validaciones'

// Las alicuotas TIPO_ALI='IV' reales de CPA14, verificadas contra la base.
// El 0% y el 3% son los dos porcentajes con mas de un codigo posible.
const CPA14: AlicuotaTango[] = [
  { codigo: 4, porcentaje: 27, descripcion: 'IVA 27%' },
  { codigo: 1, porcentaje: 21, descripcion: 'IVA 21%' },
  { codigo: 3, porcentaje: 10.5, descripcion: 'IVA 10,5%' },
  { codigo: 15, porcentaje: 3, descripcion: 'PERCEPCION R.G.3337' },
  { codigo: 16, porcentaje: 3, descripcion: 'PERCEP. DE IVA' },
  { codigo: 2, porcentaje: 0, descripcion: 'IVA 0%' },
  { codigo: 17, porcentaje: 0, descripcion: 'RETENCION IVA' },
]

describe('resolverCodigoIva', () => {
  it('resuelve los porcentajes de codigo unico', () => {
    expect(resolverCodigoIva(21, CPA14)?.codigo).toBe(1)
    expect(resolverCodigoIva(27, CPA14)?.codigo).toBe(4)
    expect(resolverCodigoIva(10.5, CPA14)?.codigo).toBe(3)
  })

  it('desempata el 3% al codigo 15, no al 16', () => {
    expect(resolverCodigoIva(3, CPA14)?.codigo).toBe(15)
  })

  it('devuelve null para un porcentaje que Tango no tiene', () => {
    expect(resolverCodigoIva(5, CPA14)).toBeNull()
  })
})

describe('resolverAlicuotas', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverAlicuotas({ porciva1: '21', impiva1: '' }, CPA14)).toEqual([])
    expect(resolverAlicuotas({}, CPA14)).toEqual([])
  })

  it('resuelve dos slots con sus codigos de Tango', () => {
    const r = resolverAlicuotas(
      { porciva1: '21', impiva1: '9.134,65', porciva2: '3', impiva2: '1.304,95' },
      CPA14,
    )
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ slot: 1, porcentaje: 21, estado: 'registra' })
    expect(r[0].alicuota?.codigo).toBe(1)
    expect(r[1]).toMatchObject({ slot: 2, porcentaje: 3, estado: 'registra' })
    expect(r[1].alicuota?.codigo).toBe(15)
  })

  it('marca la alicuota 0% como omitida en vez de resolverla', () => {
    // Norma de registracion: la 0% no se registra. Antes caia en el
    // desempate del 3% (buscaba el codigo 15), no lo encontraba y el
    // registro fallaba con "no se pudo resolver el codigo de IVA".
    const r = resolverAlicuotas({ porciva1: '0', impiva1: '1.000,00' }, CPA14)
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('omitida')
    expect(r[0].alicuota).toBeNull()
  })

  it('marca sin-codigo un porcentaje que Tango no tiene', () => {
    const r = resolverAlicuotas({ porciva1: '5', impiva1: '500,00' }, CPA14)
    expect(r[0].estado).toBe('sin-codigo')
  })

  it('lee el porcentaje con coma decimal', () => {
    const r = resolverAlicuotas({ porciva1: '10,5', impiva1: '100,00' }, CPA14)
    expect(r[0].alicuota?.codigo).toBe(3)
  })
})

describe('correccion manual del codigo', () => {
  it('el codigo elegido a mano gana sobre el que resuelve el porcentaje', () => {
    // El caso real: el 3% resuelve al 15 por norma, pero el operador
    // necesita el 16 ("PERCEP. DE IVA") para este comprobante puntual.
    const r = resolverAlicuotas(
      { porciva1: '3', impiva1: '1.000,00', codiva1: '16' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(16)
  })

  it('gana tambien sobre la regla del 0%, que si no se omitiria', () => {
    const r = resolverAlicuotas(
      { porciva1: '0', impiva1: '1.000,00', codiva1: '2' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
    expect(r[0].alicuota?.codigo).toBe(2)
  })

  it('rescata una fila que sin correccion quedaria sin codigo', () => {
    const r = resolverAlicuotas(
      { porciva1: '7', impiva1: '500,00', codiva1: '1' },
      CPA14,
    )
    expect(r[0].estado).toBe('registra')
  })

  it('un codigo corregido que no existe en Tango queda sin-codigo', () => {
    const r = resolverAlicuotas(
      { porciva1: '21', impiva1: '500,00', codiva1: '999' },
      CPA14,
    )
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('validarAlicuotas', () => {
  it('ok sin alicuotas', () => {
    expect(validarAlicuotas([]).estado).toBe('ok')
  })

  it('ok mostrando el codigo y la descripcion de cada una', () => {
    const r = validarAlicuotas(
      resolverAlicuotas(
        { porciva1: '21', impiva1: '9.134,65', porciva2: '3', impiva2: '1.304,95' },
        CPA14,
      ),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('IVA 21%')
    expect(r.mensaje).toContain('cód. 1')
    expect(r.mensaje).toContain('PERCEPCION R.G.3337')
    expect(r.mensaje).toContain('cód. 15')
  })

  it('advierte que la 0% no se registra, sin bloquear', () => {
    const r = validarAlicuotas(
      resolverAlicuotas(
        { porciva1: '21', impiva1: '9.134,65', porciva2: '0', impiva2: '500,00' },
        CPA14,
      ),
    )
    expect(r.estado).toBe('advertencia')
    expect(r.mensaje).toContain('no se registra')
    // Sigue diciendo que la 21% si se graba: el operador tiene que ver las dos cosas.
    expect(r.mensaje).toContain('IVA 21%')
  })

  it('bloquea si el porcentaje no existe en Tango', () => {
    const r = validarAlicuotas(resolverAlicuotas({ porciva1: '5', impiva1: '500,00' }, CPA14))
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('5%')
  })

  it('formatea el porcentaje con coma, como lo escribe el operador', () => {
    const r = validarAlicuotas(resolverAlicuotas({ porciva1: '7', impiva1: '10,00' }, CPA14))
    expect(r.mensaje).toContain('7%')
    const conDecimal = validarAlicuotas(
      resolverAlicuotas({ porciva1: '2,5', impiva1: '10,00' }, CPA14),
    )
    expect(conDecimal.mensaje).toContain('2,5%')
  })
})
