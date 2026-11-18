import { describe, it, expect } from 'vitest'
import { parsearDnrpa, PROMPT_DNRPA } from '@/server/ia/dnrpa'

describe('parsearDnrpa (2026-11-18)', () => {
  it('toma las filas con chasis o DNRPA y descarta las vacias', () => {
    const crudo = JSON.stringify({
      filas: [
        { modelo: 'LD 110 MAX', motor: 'YF152FMH T3160824', chasis: ' 8CMML11A5TA195590 ', dnrpa: 'M-0000903599/2026' },
        { modelo: '', motor: '', chasis: '', dnrpa: '' },
        null,
      ],
    })
    expect(parsearDnrpa(crudo)).toEqual([
      { modelo: 'LD 110 MAX', motor: 'YF152FMH T3160824', chasis: '8CMML11A5TA195590', dnrpa: 'M-0000903599/2026' },
    ])
  })

  it('el prompt no confunde el DNRPA con el certificado', () => {
    expect(PROMPT_DNRPA).toContain('No confundas NRO DNRPA con NRO CERTIFICADO')
  })
})
