import { describe, it, expect, afterAll } from 'vitest'
import { migrar } from '../../scripts/migrate'
import { getPool, cerrarPool } from '@/server/db/pool'

const TABLAS = ['PHF_COMPROBANTE', 'PHF_CAMPO', 'PHF_RENGLON', 'PHF_AUDITORIA']

describe('migracion del esquema propio', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('crea las cuatro tablas PHF_', async () => {
    await migrar()
    const pool = await getPool()
    const r = await pool
      .request()
      .query("SELECT name FROM sys.tables WHERE name LIKE 'PHF[_]%' ORDER BY name")
    const nombres = r.recordset.map((x) => x.name)
    for (const t of TABLAS) expect(nombres).toContain(t)
  })

  it('es idempotente: la segunda corrida no crea nada', async () => {
    await migrar()
    const creadas = await migrar()
    expect(creadas).toEqual([])
  })

  it('no crea tablas fuera del prefijo PHF_', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    await migrar()
    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un estado invalido', async () => {
    const pool = await getPool()
    await expect(
      pool.request().query(`
        INSERT INTO PHF_COMPROBANTE (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, USUARIO_ALTA)
        VALUES ('x.pdf', 'x', REPLICATE('0', 64), 'inventado', 'test')
      `),
    ).rejects.toThrow()
  })
})
