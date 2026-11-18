import { describe, it, expect, vi } from 'vitest'
import sql from 'mssql'

// Sin base: se intercepta conTransaccion para ver con que nivel de
// aislamiento abre la transaccion del registro.
const llamadas: unknown[] = []
vi.mock('@/server/db/tx', () => ({
  conTransaccion: vi.fn(async (_fn: unknown, nivel: unknown) => {
    llamadas.push(nivel)
    return { ncompInC: 1, tComp: 'FAC', nComp: 'A0000100000001' }
  }),
  fijarXactAbort: vi.fn(),
}))

describe('registrarComprobante', () => {
  it('corre en READ COMMITTED, como Tango, y no en SERIALIZABLE (F6, 2026-11-17)', async () => {
    const { registrarComprobante } = await import('@/server/tango/comprobantes')
    await registrarComprobante(123)
    expect(llamadas).toEqual([sql.ISOLATION_LEVEL.READ_COMMITTED])
    expect(llamadas[0]).not.toBe(sql.ISOLATION_LEVEL.SERIALIZABLE)
  })
})
