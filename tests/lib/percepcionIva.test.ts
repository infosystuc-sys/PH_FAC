import { describe, it, expect } from 'vitest'
import { esPercepcionDeIva, planificarPercepcionIva } from '@/lib/percepcionIva'

/** Los slots que analiza cada tipo, para no repetirlos en cada caso. */
const SLOTS_IVA_TARJETA = [1, 2, 3]
const SLOTS_IVA_COMPLETOS = [1, 2, 3, 4, 5]
const SLOTS_VARIOS = [1, 2]

function valor(escrituras: { clave: string; valor: string | null }[], clave: string) {
  return escrituras.find((e) => e.clave === clave)?.valor
}

describe('esPercepcionDeIva', () => {
  it('reconoce el rotulo de la liquidacion de Banco Macro que lo motivo', () => {
    expect(esPercepcionDeIva('Percep./Retenc.AFIP - DGI')).toBe(true)
  })

  it('reconoce las formas habituales', () => {
    expect(esPercepcionDeIva('Percepción IVA')).toBe(true)
    expect(esPercepcionDeIva('Perc. IVA RG 2408')).toBe(true)
    expect(esPercepcionDeIva('PERCEPCION R.G. 3337')).toBe(true)
    expect(esPercepcionDeIva('Percepcion DGI')).toBe(true)
  })

  it('no confunde las lineas de Ingresos Brutos, que tienen sus propios slots', () => {
    expect(esPercepcionDeIva('Perc. IIBB Tucumán')).toBe(false)
    expect(esPercepcionDeIva('Percepción Ingresos Brutos')).toBe(false)
    expect(esPercepcionDeIva('Ret. IIBB SIRCREB')).toBe(false)
  })

  it('no toca el SIRTAC, que convive con ella en el mismo pie', () => {
    // Asi lo imprime Banco Macro, en el renglon de arriba de la percepcion.
    expect(esPercepcionDeIva('Ret.IB SIRTAC')).toBe(false)
    expect(esPercepcionDeIva('Retención I.B. /SIRTAC')).toBe(false)
  })

  it('no toca los demas impuestos varios', () => {
    expect(esPercepcionDeIva('Impuesto a las ganancias')).toBe(false)
    expect(esPercepcionDeIva('Percepción sobre débitos/créditos')).toBe(false)
    expect(esPercepcionDeIva('Retención T.E.M. Tucumán')).toBe(false)
    expect(esPercepcionDeIva('Trib. emerg. munic.')).toBe(false)
    expect(esPercepcionDeIva('Deduc. Impositivas')).toBe(false)
  })

  it('exige que diga percepcion: una retencion de IVA resolveria al codigo equivocado', () => {
    expect(esPercepcionDeIva('Retención IVA')).toBe(false)
  })

  it('no reconoce nada en un texto vacio', () => {
    expect(esPercepcionDeIva('')).toBe(false)
    expect(esPercepcionDeIva(null)).toBe(false)
  })
})

describe('planificarPercepcionIva', () => {
  it('muda la percepcion al primer par de IVA libre y deja el porcentaje vacio', () => {
    // El comprobante 00208179 tal como quedo: IVA 21% en el slot 1, SIRTAC
    // en varios1 y la percepcion de AFIP trabada en varios2.
    const plan = planificarPercepcionIva(
      {
        porciva1: '21,00',
        impiva1: '680,53',
        varios1: 'Ret.IB SIRTAC',
        impvarios1: '2.592,49',
        varios2: 'Percep./Retenc.AFIP - DGI',
        impvarios2: '97,21',
      },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )

    expect(plan.mudados).toEqual(['Percep./Retenc.AFIP - DGI'])
    expect(plan.sinLugar).toBe(0)
    expect(valor(plan.escrituras, 'impiva2')).toBe('97,21')
    // Vacio, no "0": son cosas distintas para resolverAlicuotas.
    expect(valor(plan.escrituras, 'porciva2')).toBeNull()
    // El 21% no se toca.
    expect(plan.escrituras.some((e) => e.clave === 'impiva1')).toBe(false)
  })

  it('deja el SIRTAC donde estaba y le libera el slot 2', () => {
    const plan = planificarPercepcionIva(
      {
        impiva1: '680,53',
        porciva1: '21,00',
        varios1: 'Ret.IB SIRTAC',
        impvarios1: '2.592,49',
        varios2: 'Percep./Retenc.AFIP - DGI',
        impvarios2: '97,21',
      },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )

    expect(valor(plan.escrituras, 'varios1')).toBe('Ret.IB SIRTAC')
    expect(valor(plan.escrituras, 'impvarios1')).toBe('2.592,49')
    expect(valor(plan.escrituras, 'varios2')).toBeNull()
    expect(valor(plan.escrituras, 'impvarios2')).toBeNull()
  })

  it('compacta los varios que quedan, sin dejar hueco en el slot 1', () => {
    const plan = planificarPercepcionIva(
      {
        varios1: 'Percepción IVA RG 2408',
        impvarios1: '97,21',
        varios2: 'Ret.IB SIRTAC',
        impvarios2: '2.592,49',
        codvarios2: '67',
      },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )

    expect(valor(plan.escrituras, 'varios1')).toBe('Ret.IB SIRTAC')
    // El codigo que el operador ya habia elegido viaja con su linea.
    expect(valor(plan.escrituras, 'codvarios1')).toBe('67')
    expect(valor(plan.escrituras, 'varios2')).toBeNull()
    expect(valor(plan.escrituras, 'codvarios2')).toBeNull()
  })

  it('respeta el codigo que el operador ya eligio a mano', () => {
    // Si eligio un impuesto vario para esa linea, decidio que es un vario:
    // esa correccion gana sobre el reconocimiento automatico.
    const plan = planificarPercepcionIva(
      { varios1: 'Percep./Retenc.AFIP - DGI', impvarios1: '97,21', codvarios1: '53' },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )
    expect(plan.escrituras).toEqual([])
    expect(plan.mudados).toEqual([])
  })

  it('no pisa un importe de IVA real cuando no queda par libre', () => {
    const plan = planificarPercepcionIva(
      {
        impiva1: '680,53',
        impiva2: '100,00',
        impiva3: '50,00',
        varios1: 'Percep./Retenc.AFIP - DGI',
        impvarios1: '97,21',
      },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )
    expect(plan.escrituras).toEqual([])
    expect(plan.sinLugar).toBe(1)
  })

  it('no usa los pares que tarjeta cede al array de cargos', () => {
    // Con los cinco slots la percepcion entraria en el 4; en tarjeta el 4 y
    // el 5 no se analizan, asi que ahi no hay lugar.
    const valores = {
      impiva1: '1',
      impiva2: '2',
      impiva3: '3',
      varios1: 'Percep./Retenc.AFIP - DGI',
      impvarios1: '97,21',
    }
    expect(planificarPercepcionIva(valores, SLOTS_IVA_TARJETA, SLOTS_VARIOS).sinLugar).toBe(1)
    expect(valor(planificarPercepcionIva(valores, SLOTS_IVA_COMPLETOS, SLOTS_VARIOS).escrituras, 'impiva4')).toBe('97,21')
  })

  it('muda las dos cuando hay dos', () => {
    const plan = planificarPercepcionIva(
      {
        varios1: 'Percepción IVA RG 2408',
        impvarios1: '97,21',
        varios2: 'Percepción R.G. 3337',
        impvarios2: '15,00',
      },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )
    expect(plan.mudados).toHaveLength(2)
    expect(valor(plan.escrituras, 'impiva1')).toBe('97,21')
    expect(valor(plan.escrituras, 'impiva2')).toBe('15,00')
    expect(valor(plan.escrituras, 'varios1')).toBeNull()
    expect(valor(plan.escrituras, 'varios2')).toBeNull()
  })

  it('no hace nada cuando no hay ninguna percepcion de IVA en varios', () => {
    const plan = planificarPercepcionIva(
      { impiva1: '680,53', varios1: 'Ret.IB SIRTAC', impvarios1: '2.592,49' },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )
    expect(plan.escrituras).toEqual([])
  })

  it('no muda una linea sin importe: no hay nada que registrar', () => {
    const plan = planificarPercepcionIva(
      { varios1: 'Percep./Retenc.AFIP - DGI', impvarios1: '' },
      SLOTS_IVA_TARJETA,
      SLOTS_VARIOS,
    )
    expect(plan.escrituras).toEqual([])
  })
})
