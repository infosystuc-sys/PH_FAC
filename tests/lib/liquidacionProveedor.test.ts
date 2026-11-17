import { describe, it, expect } from 'vitest'
import { reglaLiquidacionPorCuit } from '@/lib/liquidacionProveedor'

describe('reglaLiquidacionPorCuit', () => {
  it('reconoce a CrediCash (CASTILLO, 010139) por el CUIT impreso', () => {
    expect(reglaLiquidacionPorCuit('30-52948352-2')?.codProvee).toBe('010139')
    expect(reglaLiquidacionPorCuit('30529483522')?.codProvee).toBe('010139')
  })

  it('no depende del dígito verificador, que se lee distinto', () => {
    expect(reglaLiquidacionPorCuit('30-52948352-3')?.codProvee).toBe('010139')
  })

  it('otro CUIT o uno incompleto no tiene regla', () => {
    expect(reglaLiquidacionPorCuit('30-70237535-1')).toBeNull()
    expect(reglaLiquidacionPorCuit('30-5294835')).toBeNull()
    expect(reglaLiquidacionPorCuit(null)).toBeNull()
  })

  it('la instrucción deja afuera ventas, neto a pagar e impuestos', () => {
    const i = reglaLiquidacionPorCuit('30-52948352-2')!.instruccion
    expect(i).toContain('IMPORTE VENTAS')
    expect(i).toContain('NETO A PAGAR')
    expect(i).toContain('IMPUESTO AL DEBITO')
  })
})
