import { describe, it, expect } from 'vitest'
import { ESTADOS, ORDEN_TABS, esTerminal, permiteRegistrar } from '@/lib/estados'

describe('modelo de estados', () => {
  it('define los seis estados del spec', () => {
    expect(Object.keys(ESTADOS).sort()).toEqual(
      ['confirmado', 'error', 'leido', 'observacion', 'procesando', 'registrado'].sort(),
    )
  })

  it('usa los labels del diseno', () => {
    expect(ESTADOS.leido.label).toBe('Pendiente de revisión')
    expect(ESTADOS.registrado.label).toBe('Registrado en Tango')
  })

  it('registrado es terminal', () => {
    expect(esTerminal('registrado')).toBe(true)
    expect(esTerminal('confirmado')).toBe(false)
  })

  it('solo confirmado habilita el registro en Tango', () => {
    expect(permiteRegistrar('confirmado')).toBe(true)
    expect(permiteRegistrar('leido')).toBe(false)
    expect(permiteRegistrar('registrado')).toBe(false)
  })

  it('los tabs van en el orden del diseno', () => {
    expect(ORDEN_TABS.map((t) => t.clave)).toEqual([
      'todos',
      'leido',
      'observacion',
      'confirmado',
      'registrado',
      'error',
    ])
  })
})
