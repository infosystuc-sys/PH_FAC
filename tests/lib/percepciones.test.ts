import { describe, it, expect } from 'vitest'
import { resolverPercepciones, resolverVarios, codigosVarios } from '@/lib/percepciones'
import { validarPercepciones, validarVarios } from '@/lib/validaciones'

// Los codigos no-IVA reales de CPA14, verificados contra la base.
const CPA14_NO_IVA = [
  { codigo: 40, descripcion: 'IMP INT' },
  { codigo: 52, descripcion: 'IMP. INTERNO NULO' },
  { codigo: 53, descripcion: 'IMP. A LAS GANANCIAS' },
  { codigo: 54, descripcion: 'RETENCION DE GANANCI' },
  { codigo: 55, descripcion: 'PERC. TEM Y PYP' },
  { codigo: 56, descripcion: 'RETENCION MUNICIPAL' },
  { codigo: 60, descripcion: 'PERCEPCION IIBB TUC' },
  { codigo: 61, descripcion: 'PERCEPCION IIBB SALT' },
  { codigo: 62, descripcion: 'PERCEPCION IIBB CABA' },
  { codigo: 63, descripcion: 'RET IIBB TUCUMAN' },
  { codigo: 64, descripcion: 'RET IIBB BANCARIOS' },
  { codigo: 65, descripcion: 'PERCEP DEB Y CRED RG' },
  { codigo: 66, descripcion: 'RET IIBB SIRCREB' },
  { codigo: 67, descripcion: 'RET SIRTAC' },
  { codigo: 68, descripcion: 'PERCEP IIBB FORMOSA' },
]

describe('codigosVarios', () => {
  it('deja afuera los cinco codigos de percepcion de IIBB', () => {
    const codigos = codigosVarios(CPA14_NO_IVA).map((c) => c.codigo)
    for (const percepcion of [60, 61, 62, 64, 66]) {
      expect(codigos, `el ${percepcion} no deberia estar en varios`).not.toContain(percepcion)
    }
  })

  it('deja los diez que aprobo el usuario', () => {
    expect(codigosVarios(CPA14_NO_IVA).map((c) => c.codigo).sort((a, b) => a - b)).toEqual([
      40, 52, 53, 54, 55, 56, 63, 65, 67, 68,
    ])
  })
})

describe('resolverPercepciones', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverPercepciones({ percep1: 'Tucumán', imppercep1: '' })).toEqual([])
    expect(resolverPercepciones({})).toEqual([])
  })

  it('resuelve dos jurisdicciones distintas a sus codigos', () => {
    const r = resolverPercepciones({
      percep1: 'Tucumán', imppercep1: '7.748,86',
      percep2: 'CABA', imppercep2: '1.120,08',
    })
    expect(r).toHaveLength(2)
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('60')
    expect(r[1].codigo?.codigo).toBe('62')
  })

  it('marca sin-codigo una jurisdiccion que no esta en la norma', () => {
    const r = resolverPercepciones({ percep1: 'Córdoba', imppercep1: '500,00' })
    expect(r[0].estado).toBe('sin-codigo')
    expect(r[0].codigo).toBeNull()
  })

  it('un importe sin jurisdiccion tambien queda sin-codigo, no se ignora', () => {
    // Si se ignorara, el importe contaria en el total imputado pero no se
    // grabaria en CPA18: el comprobante entraria a Tango por menos.
    const r = resolverPercepciones({ percep1: '', imppercep1: '500,00' })
    expect(r).toHaveLength(1)
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('correccion manual de la percepcion', () => {
  it('el codigo elegido a mano gana sobre la jurisdiccion leida', () => {
    const r = resolverPercepciones({
      percep1: 'Tucumán', imppercep1: '500,00', codpercep1: '61',
    })
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('61')
  })

  it('rescata una jurisdiccion que sin correccion no se reconoceria', () => {
    const r = resolverPercepciones({
      percep1: 'Córdoba', imppercep1: '500,00', codpercep1: '60',
    })
    expect(r[0].estado).toBe('registra')
    expect(r[0].codigo?.codigo).toBe('60')
  })

  it('un codigo corregido fuera de la norma queda sin-codigo', () => {
    const r = resolverPercepciones({
      percep1: 'Tucumán', imppercep1: '500,00', codpercep1: '63',
    })
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('resolverVarios', () => {
  it('ignora los slots sin importe', () => {
    expect(resolverVarios({ varios1: '40', impvarios1: '' }, CPA14_NO_IVA)).toEqual([])
  })

  it('resuelve el codigo elegido a su descripcion de Tango', () => {
    const r = resolverVarios({ varios1: '40', impvarios1: '1.234,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('registra')
    expect(r[0].descripcion).toBe('IMP INT')
  })

  it('rechaza un codigo que es de percepcion, no de varios', () => {
    // El 60 existe en CPA14 pero pertenece a la familia de percepciones:
    // si entrara por aca se grabaria dos veces la misma clase de linea.
    const r = resolverVarios({ varios1: '60', impvarios1: '1.000,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('sin-codigo')
  })

  it('rechaza un codigo inexistente', () => {
    const r = resolverVarios({ varios1: '999', impvarios1: '1.000,00' }, CPA14_NO_IVA)
    expect(r[0].estado).toBe('sin-codigo')
  })
})

describe('validarPercepciones', () => {
  it('ok sin lineas', () => {
    expect(validarPercepciones([]).estado).toBe('ok')
  })

  it('ok mostrando jurisdiccion y codigo de cada una', () => {
    const r = validarPercepciones(
      resolverPercepciones({ percep1: 'Tucumán', imppercep1: '7.748,86' }),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('Tucumán')
    expect(r.mensaje).toContain('60')
  })

  it('bloquea con la jurisdiccion textual que no se reconocio', () => {
    const r = validarPercepciones(
      resolverPercepciones({ percep1: 'Córdoba', imppercep1: '500,00' }),
    )
    expect(r.estado).toBe('error')
    expect(r.mensaje).toContain('Córdoba')
  })
})

describe('validarVarios', () => {
  it('ok sin lineas', () => {
    expect(validarVarios([]).estado).toBe('ok')
  })

  it('ok mostrando codigo y descripcion', () => {
    const r = validarVarios(
      resolverVarios({ varios1: '40', impvarios1: '1.234,00' }, CPA14_NO_IVA),
    )
    expect(r.estado).toBe('ok')
    expect(r.mensaje).toContain('IMP INT')
  })

  it('bloquea si hay importe sin codigo elegido', () => {
    const r = validarVarios(resolverVarios({ impvarios1: '1.234,00' }, CPA14_NO_IVA))
    expect(r.estado).toBe('error')
  })
})
