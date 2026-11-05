import { describe, it, expect } from 'vitest'
import { colorDelCodigoImsa, reglaSeriesDe } from '@/lib/seriesProveedor'
import { parsearSeries, armarPromptSeries } from '@/server/ia/series'

describe('colorDelCodigoImsa', () => {
  it('toma lo que sigue a los 8 primeros caracteres, hasta el próximo guion', () => {
    expect(colorDelCodigoImsa('MNTD-150NE-LLE2')).toBe('NE')
    expect(colorDelCodigoImsa('MNTD-150AZ-LLE2')).toBe('AZ')
    expect(colorDelCodigoImsa(' MNTD-150BL-LLE2 ')).toBe('BL')
  })

  it('sin nada después del modelo, queda vacío', () => {
    expect(colorDelCodigoImsa('MNTD-150')).toBe('')
  })
})

describe('reglaSeriesDe', () => {
  it('IMSA (010337) lee chasis y motor', () => {
    const r = reglaSeriesDe(' 010337 ')
    expect(r?.columnaSerie).toBe('Chasis')
    expect(r?.columnaAdicional1).toBe('Motor')
  })

  it('un proveedor sin regla no tiene', () => {
    expect(reglaSeriesDe('010685')).toBeNull()
    expect(reglaSeriesDe(null)).toBeNull()
  })
})

describe('parsearSeries', () => {
  it('aplana las unidades de cada renglón y descarta las que no traen serie', () => {
    const crudo = JSON.stringify({
      renglones: [
        { orden: 1, unidades: [{ serie: '8CMMT15A1TA012342', adicional1: '162FMJ T3150343' }] },
        {
          orden: 2,
          unidades: [
            { serie: ' 8CMMT15A0TA012462 ', adicional1: '162FMJ T3210968' },
            { serie: '', adicional1: '162FMJ T3150234' },
          ],
        },
        { orden: 0, unidades: [{ serie: 'X', adicional1: '' }] },
      ],
    })
    expect(parsearSeries(crudo)).toEqual([
      { orden: 1, serie: '8CMMT15A1TA012342', adicional1: '162FMJ T3150343' },
      { orden: 2, serie: '8CMMT15A0TA012462', adicional1: '162FMJ T3210968' },
    ])
  })
})

describe('armarPromptSeries', () => {
  it('nombra las columnas de la regla y los renglones leídos', () => {
    const p = armarPromptSeries(
      [{ orden: 1, codigo: 'MNTD-150NE-LLE2', cantidad: '1,00' }],
      reglaSeriesDe('010337')!,
    )
    expect(p).toContain('"Chasis"')
    expect(p).toContain('"Motor"')
    expect(p).toContain('1. código MNTD-150NE-LLE2, cantidad 1,00')
  })
})
