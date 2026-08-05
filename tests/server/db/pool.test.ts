import { describe, it, expect, afterAll } from 'vitest'
import { getPool, probarConexion, cerrarPool } from '@/server/db/pool'

describe('pool de SQL Server', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('conecta a PUNTO_HOGAR_1', async () => {
    const pool = await getPool()
    const r = await pool.request().query('SELECT DB_NAME() AS db')
    expect(r.recordset[0].db).toBe('PUNTO_HOGAR_1')
  })

  it('devuelve el mismo pool en llamadas sucesivas', async () => {
    const a = await getPool()
    const b = await getPool()
    expect(a).toBe(b)
  })

  it('probarConexion informa ok y la version del motor', async () => {
    const r = await probarConexion()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.version).toContain('SQL Server')
  })
})
