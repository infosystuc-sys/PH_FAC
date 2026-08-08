import { describe, it, expect, afterAll } from 'vitest'
import { getPool } from '@/server/db/pool'
import { cerrarPool } from '@/server/db/pool'
import { buscarFacturaEnCpa04, mapearAlicuotaIva } from '@/server/tango/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarFacturaEnCpa04', () => {
  it('encuentra una factura real por proveedor + N_COMP', async () => {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 COD_PROVEE, N_COMP FROM CPA04 WHERE T_COMP = 'FAC' ORDER BY NCOMP_IN_C DESC
    `)
    const fila = r.recordset[0]
    const encontrado = await buscarFacturaEnCpa04(fila.COD_PROVEE, fila.N_COMP)
    expect(encontrado).not.toBeNull()
    expect(encontrado!.nComp).toBe(fila.N_COMP.trim())
  })

  it('devuelve null si no hay ninguna factura con ese N_COMP', async () => {
    const r = await buscarFacturaEnCpa04('999999', 'Z9999999999999')
    expect(r).toBeNull()
  })
})

describe('mapearAlicuotaIva', () => {
  it('resuelve un porcentaje sin ambiguedad (21%) sin necesitar codigo elegido', async () => {
    const r = await mapearAlicuotaIva(21, null)
    expect(r).not.toBeNull()
    expect(r!.codigo).toBe(1)
    expect(r!.porcentaje).toBe(21)
  })

  it('resuelve 10,5% sin ambiguedad', async () => {
    const r = await mapearAlicuotaIva(10.5, null)
    expect(r!.codigo).toBe(3)
  })

  it('al 3% (ambiguo), usa el codigo elegido por el operador', async () => {
    const r16 = await mapearAlicuotaIva(3, '16')
    expect(r16!.codigo).toBe(16)

    const r15 = await mapearAlicuotaIva(3, '15')
    expect(r15!.codigo).toBe(15)
  })

  it('al 3% sin codigo elegido, devuelve null (el llamador debe haber bloqueado esto antes)', async () => {
    const r = await mapearAlicuotaIva(3, null)
    expect(r).toBeNull()
  })

  it('devuelve null si el porcentaje no matchea ningun codigo', async () => {
    const r = await mapearAlicuotaIva(99, null)
    expect(r).toBeNull()
  })
})
