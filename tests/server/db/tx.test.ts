import { describe, it, expect, afterAll } from 'vitest'
import { conTransaccion, conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'

describe('helpers de transaccion', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('conTransaccion devuelve el valor de la funcion', async () => {
    const r = await conTransaccion(async (tx) => {
      const q = await tx.request().query('SELECT 42 AS n')
      return q.recordset[0].n
    })
    expect(r).toBe(42)
  })

  it('conTransaccion propaga el error y hace rollback', async () => {
    await expect(
      conTransaccion(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  it('conRollback no deja rastro de lo escrito', async () => {
    await conRollback(async (tx) => {
      // .batch() en vez de .query(): mssql ejecuta .query() via sp_executesql,
      // que crea la tabla temporal en un scope propio y la descarta al volver.
      // Ver README de mssql, seccion "batch": "you should use this if you're
      // plan to work with local temporary tables".
      await tx.request().batch('CREATE TABLE #t (a INT); INSERT INTO #t VALUES (1)')
      const q = await tx.request().query('SELECT COUNT(*) AS n FROM #t')
      expect(q.recordset[0].n).toBe(1)
    })
  })
})
