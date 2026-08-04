import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conTransaccion, conRollback } from '@/server/db/tx'
import { cerrarPool, getPool } from '@/server/db/pool'

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
    // Una tabla temporal (#t) es de scope de sesion: no sirve para verificar
    // "despues" del rollback, porque el pool puede devolvernos otra conexion
    // en la siguiente request y ni siquiera veriamos el error. Usamos una
    // tabla real con prefijo PHF_ (convencion del proyecto) y nombre unico
    // por corrida: el DDL en SQL Server es transaccional, asi que el
    // CREATE TABLE desaparece con el rollback y eso se puede confirmar desde
    // afuera de la transaccion consultando sys.tables.
    const tabla = `PHF_test_tx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    const pool = await getPool()

    try {
      await conRollback(async (tx) => {
        // .batch() en vez de .query(): mssql ejecuta .query() via sp_executesql,
        // que no admite ciertas sentencias DDL como primera instruccion del
        // batch. Ver README de mssql, seccion "batch".
        await tx.request().batch(`CREATE TABLE ${tabla} (a INT)`)

        const dentro = await tx
          .request()
          .input('tabla', sql.VarChar, tabla)
          .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @tabla')
        expect(dentro.recordset[0].n).toBe(1)
      })

      // Fuera de conRollback: si el rollback funciono, sys.tables no deberia
      // ver la tabla desde ninguna conexion del pool.
      const despues = await pool
        .request()
        .input('tabla', sql.VarChar, tabla)
        .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @tabla')
      expect(despues.recordset[0].n).toBe(0)
    } finally {
      // Red de seguridad: si el test corta a mitad de camino (por ejemplo la
      // asercion de "despues" fallara con la tabla todavia viva), no
      // queremos dejar una tabla PHF_ huerfana en la base.
      await pool
        .request()
        .batch(`IF OBJECT_ID('dbo.${tabla}') IS NOT NULL DROP TABLE ${tabla}`)
    }
  })
})
