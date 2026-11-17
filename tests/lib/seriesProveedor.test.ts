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

describe('NEWSAN (010003)', () => {
  it('lee VIN, motor y DNRPA, e ignora el "Nro Serie"', () => {
    const r = reglaSeriesDe('010003')!
    expect(r.columnaSerie).toBe('Nro VIN')
    expect(r.columnaAdicional1).toBe('Nro Motor')
    expect(r.columnaComentario).toBe('Nro DNRPA')
    const p = armarPromptSeries([{ orden: 1, codigo: 'CUBQU110BASEAZUL', cantidad: '1' }], r)
    expect(p).toContain('"comentario": lo de la columna "Nro DNRPA"')
    expect(p).toContain('NO uses la columna "Nro Serie"')
  })

  it('el color es lo que sigue a los 12 primeros caracteres del código', () => {
    const r = reglaSeriesDe('010003')!
    expect(r.adicional2DelCodigo('CUBQU110BASEAZUL')).toBe('AZUL')
    expect(r.adicional2DelCodigo('CUBQU110BASEROJO')).toBe('ROJO')
  })

  it('IMSA sigue sin DNRPA en el prompt', () => {
    const p = armarPromptSeries([{ orden: 1, codigo: 'MNTD-150NE-LLE2', cantidad: '1' }], reglaSeriesDe('010337')!)
    expect(p).not.toContain('"comentario"')
    expect(p).not.toContain('NO uses')
  })
})

describe('parsearSeries con el DNRPA', () => {
  it('trae el comentario cuando viene, y lo omite vacío', () => {
    const crudo = JSON.stringify({
      renglones: [
        {
          orden: 1,
          unidades: [
            { serie: '8BFXCH2GSVC001834', adicional1: '1P52FMH T1249660', comentario: 'M-0000887730/2026' },
            { serie: '8BFXCH2GSVC001820', adicional1: '1P52FMH T1249683', comentario: '' },
          ],
        },
      ],
    })
    expect(parsearSeries(crudo)).toEqual([
      { orden: 1, serie: '8BFXCH2GSVC001834', adicional1: '1P52FMH T1249660', comentario: 'M-0000887730/2026' },
      { orden: 1, serie: '8BFXCH2GSVC001820', adicional1: '1P52FMH T1249683' },
    ])
  })
})
