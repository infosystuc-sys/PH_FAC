import { describe, it, expect } from 'vitest'
import { totalImputado, parsearImporte } from '@/lib/formato'

describe('totalImputado', () => {
  it('cierra exacto contra el total de una factura real con dos bases de IVA', () => {
    // AMX ARGENTINA SA, comprobante 1340-00147868, extraído del PDF real.
    // Dos bases imponibles: 21% y 27%, más la percepción de IVA en un slot.
    const v = {
      neto: '529.947,50',
      exento: '',
      porciva1: '21.0', impiva1: '39.190,99',
      porciva2: '27.0', impiva2: '92.697,41',
      porciva3: '3',    impiva3: '15.898,43',
      porciva4: '',     impiva4: '',
      porciva5: '',     impiva5: '',
      imppercep1: '13.248,69',
      impvarios1: '',
      total: '690.983,02',
    }
    expect(totalImputado(v)).toBeCloseTo(690983.02, 2)
  })

  it('no suma los porcentajes de alicuota', () => {
    // Si los porciva entraran en la suma, esto daría 121 en vez de 100.
    const v = { neto: '100,00', porciva1: '21.0', porciva2: '', impiva1: '', imppercep1: '' }
    expect(totalImputado(v)).toBeCloseTo(100, 2)
  })

  it('da 0 cuando no hay ningun importe cargado', () => {
    expect(totalImputado({})).toBe(0)
  })

  it('ignora un importe que no parsea en vez de contaminar el total', () => {
    const v = { neto: '100,00', impiva1: 'ilegible' }
    expect(totalImputado(v)).toBeCloseTo(100, 2)
  })
})

describe('parsearImporte (ya existente, no se reescribe)', () => {
  it('parsea el formato argentino con miles y decimales', () => {
    expect(parsearImporte('322.982,28')).toBeCloseTo(322982.28, 2)
  })
})
