import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { actualizarPrecioUltimaCompraEn } from '@/server/tango/preciosCompra'

afterAll(async () => {
  await cerrarPool()
})

/**
 * STA12 es una tabla de Tango: estos tests LEEN artículos y proveedores
 * reales y escriben solo dentro de `conRollback`, que deshace todo.
 */
async function unArticuloSinFila(): Promise<string | null> {
  const pool = await getPool()
  const r = await pool.request().query<{ art: string }>(`
    SELECT TOP 1 LTRIM(RTRIM(a.COD_ARTICU)) AS art
    FROM STA11 a LEFT JOIN STA12 s ON s.COD_ARTICU = a.COD_ARTICU
    WHERE s.COD_ARTICU IS NULL ORDER BY a.COD_ARTICU`)
  return r.recordset[0]?.art ?? null
}

async function unProveedor(): Promise<string> {
  const pool = await getPool()
  const r = await pool.request().query<{ cod: string }>(
    `SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS cod FROM CPA01 ORDER BY COD_PROVEE`,
  )
  return r.recordset[0].cod
}

describe('actualizarPrecioUltimaCompraEn', () => {
  it('crea la fila de un articulo comprado por primera vez, enlazada al maestro', async () => {
    // 3.077 de los 9.447 articulos no tienen fila en STA12: los que nunca
    // se compraron. La primera compra tiene que crearla.
    const art = await unArticuloSinFila()
    expect(art).not.toBeNull()
    const prov = await unProveedor()

    await conRollback(async (tx) => {
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: art!,
        precioNeto: 1234.56,
        codProvee: prov,
        fechaContable: new Date(2026, 8, 30),
        cotizacion: 1,
        monCte: true,
      })

      const r = await tx.request().input('a', sql.VarChar(20), art!)
        .query(`
          SELECT PRECIO_U_L, PRECIO_U_E, PRECIO_REP, COD_PROV_U, FECHA_ULC, FECHA_REPOS,
                 MON_CTE, MON_CTE_UC, ID_STA11, ID_CPA01, PRECIO_S_L, FECHA_COSTO_ST
          FROM STA12 WHERE COD_ARTICU = @a`)
      expect(r.recordset).toHaveLength(1)
      const f = r.recordset[0]
      expect(Number(f.PRECIO_U_L)).toBe(1234.56)
      expect(Number(f.PRECIO_REP)).toBe(1234.56)
      expect(String(f.COD_PROV_U).trim()).toBe(prov)
      expect(new Date(f.FECHA_ULC).getTime()).toBe(new Date(2026, 8, 30).getTime())
      expect(new Date(f.FECHA_REPOS).getTime()).toBe(new Date(2026, 8, 30).getTime())
      // Enlazada al maestro y al proveedor: son los dos FK que Tango usa.
      expect(f.ID_STA11).not.toBeNull()
      expect(f.ID_CPA01).not.toBeNull()
      // El costo de stock arranca en cero: no es lo que esta app calcula.
      expect(Number(f.PRECIO_S_L)).toBe(0)
      expect(new Date(f.FECHA_COSTO_ST).getFullYear()).toBe(1800)
    })
  }, 30000)

  it('divide por la cotizacion para el precio en moneda extranjera', async () => {
    const art = await unArticuloSinFila()
    const prov = await unProveedor()

    await conRollback(async (tx) => {
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: art!,
        precioNeto: 970,
        codProvee: prov,
        fechaContable: new Date(2026, 8, 30),
        cotizacion: 0.97,
        monCte: true,
      })
      const r = await tx.request().input('a', sql.VarChar(20), art!)
        .query(`SELECT PRECIO_U_L, PRECIO_U_E FROM STA12 WHERE COD_ARTICU = @a`)
      expect(Number(r.recordset[0].PRECIO_U_L)).toBe(970)
      expect(Number(r.recordset[0].PRECIO_U_E)).toBeCloseTo(1000, 4)
    })
  }, 30000)

  it('una cotizacion en cero no rompe la division: vale 1', async () => {
    const art = await unArticuloSinFila()
    const prov = await unProveedor()

    await conRollback(async (tx) => {
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: art!,
        precioNeto: 500,
        codProvee: prov,
        fechaContable: new Date(2026, 8, 30),
        cotizacion: 0,
        monCte: true,
      })
      const r = await tx.request().input('a', sql.VarChar(20), art!)
        .query(`SELECT PRECIO_U_E FROM STA12 WHERE COD_ARTICU = @a`)
      expect(Number(r.recordset[0].PRECIO_U_E)).toBe(500)
    })
  }, 30000)

  it('actualiza la fila existente en vez de crear otra: IX_0 es unico por articulo', async () => {
    const pool = await getPool()
    const existente = (await pool.request().query<{ art: string }>(
      `SELECT TOP 1 LTRIM(RTRIM(COD_ARTICU)) AS art FROM STA12 WHERE PRECIO_U_L > 0 ORDER BY COD_ARTICU`,
    )).recordset[0].art
    const prov = await unProveedor()

    await conRollback(async (tx) => {
      const antes = await tx.request().input('a', sql.VarChar(20), existente)
        .query(`SELECT ID_STA12 FROM STA12 WHERE COD_ARTICU = @a`)

      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: existente,
        precioNeto: 777.77,
        codProvee: prov,
        fechaContable: new Date(2026, 8, 30),
        cotizacion: 1,
        monCte: true,
      })

      const despues = await tx.request().input('a', sql.VarChar(20), existente)
        .query(`SELECT ID_STA12, PRECIO_U_L FROM STA12 WHERE COD_ARTICU = @a`)
      expect(despues.recordset).toHaveLength(1)
      expect(Number(despues.recordset[0].ID_STA12)).toBe(Number(antes.recordset[0].ID_STA12))
      expect(Number(despues.recordset[0].PRECIO_U_L)).toBe(777.77)
    })
  }, 30000)

  it('no escribe nada sin articulo o sin precio', async () => {
    const prov = await unProveedor()
    await conRollback(async (tx) => {
      const antes = await tx.request().query(`SELECT COUNT(*) AS n FROM STA12`)
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: '  ', precioNeto: 100, codProvee: prov,
        fechaContable: new Date(), cotizacion: 1, monCte: true,
      })
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu: 'NO-EXISTE-ZZZ', precioNeto: 0, codProvee: prov,
        fechaContable: new Date(), cotizacion: 1, monCte: true,
      })
      const despues = await tx.request().query(`SELECT COUNT(*) AS n FROM STA12`)
      expect(Number(despues.recordset[0].n)).toBe(Number(antes.recordset[0].n))
    })
  }, 30000)
})
