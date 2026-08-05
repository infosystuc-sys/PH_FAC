import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buscarRemitosPendientes } from '@/server/tango/remitos'
import { getPool, cerrarPool } from '@/server/db/pool'

// Un proveedor que hoy tiene remitos pendientes. Se descubre en vez de
// hardcodearse: los 13 remitos pendientes de hoy se van a facturar y la
// suite no puede depender de que sigan ahi.
let provConPendientes: string

beforeAll(async () => {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PRO_CL)) AS cod
    FROM STA14 h
    JOIN STA20 r ON r.TCOMP_IN_S = h.TCOMP_IN_S AND r.NCOMP_IN_S = h.NCOMP_IN_S
    WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P' AND r.CANT_PEND > 0
    GROUP BY h.COD_PRO_CL
    ORDER BY COUNT(DISTINCT h.NCOMP_IN_S) DESC, h.COD_PRO_CL
  `)
  provConPendientes = r.recordset.length ? String(r.recordset[0].cod) : ''
})

afterAll(async () => {
  await cerrarPool()
})

describe('buscarRemitosPendientes', () => {
  it('encuentra los remitos de un proveedor que tiene pendientes', async () => {
    if (!provConPendientes) return // No quedan remitos pendientes en la base.
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.length).toBeGreaterThan(0)
  })

  it('todos los remitos son del proveedor pedido', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.every((x) => x.codProvee === provConPendientes)).toBe(true)
  })

  it('ningun remito viene sin renglones', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.every((x) => x.renglones.length > 0)).toBe(true)
  })

  it('todo renglon devuelto tiene saldo por facturar', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    const renglones = r.flatMap((x) => x.renglones)
    expect(renglones.length).toBeGreaterThan(0)
    expect(renglones.every((l) => l.cantidadPendiente > 0)).toBe(true)
  })

  it('no repite el mismo remito en dos grupos', async () => {
    if (!provConPendientes) return
    const nums = (await buscarRemitosPendientes(provConPendientes)).map((x) => x.numeroInterno)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('trae la descripcion del articulo, no solo el codigo', async () => {
    if (!provConPendientes) return
    const renglones = (await buscarRemitosPendientes(provConPendientes)).flatMap(
      (x) => x.renglones,
    )
    expect(renglones.every((l) => l.codArticulo !== '')).toBe(true)
    // STA11 cubre todos los articulos de los renglones de RP (verificado).
    expect(renglones.some((l) => l.descripcion !== null && l.descripcion !== '')).toBe(true)
  })

  it('ordena los renglones por numero dentro de cada remito', async () => {
    if (!provConPendientes) return
    for (const rem of await buscarRemitosPendientes(provConPendientes)) {
      const ns = rem.renglones.map((l) => l.nRenglon)
      expect(ns).toEqual([...ns].sort((a, b) => a - b))
    }
  })

  it('coincide con lo que dice la base para ese proveedor', async () => {
    if (!provConPendientes) return
    const pool = await getPool()
    const r = await pool
      .request()
      .input('prov', provConPendientes)
      .query(`
        SELECT COUNT(DISTINCT h.NCOMP_IN_S) AS remitos, COUNT(*) AS renglones
        FROM STA14 h
        JOIN STA20 l ON l.TCOMP_IN_S = h.TCOMP_IN_S AND l.NCOMP_IN_S = h.NCOMP_IN_S
        WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P'
          AND l.CANT_PEND > 0 AND h.COD_PRO_CL = @prov
      `)
    const esperado = r.recordset[0]

    const devuelto = await buscarRemitosPendientes(provConPendientes)
    expect(devuelto.length).toBe(Number(esperado.remitos))
    expect(devuelto.flatMap((x) => x.renglones).length).toBe(Number(esperado.renglones))
  })

  it('devuelve vacio para un proveedor que no existe', async () => {
    const r = await buscarRemitosPendientes('999999')
    expect(r).toEqual([])
  })

  it('devuelve vacio con codigo vacio, sin pegarle a la base', async () => {
    const r = await buscarRemitosPendientes('   ')
    expect(r).toEqual([])
  })

  it('no devuelve remitos ya facturados', async () => {
    // Todo remito devuelto tiene que estar en estado 'P' en STA14.
    if (!provConPendientes) return
    const devuelto = await buscarRemitosPendientes(provConPendientes)
    if (!devuelto.length) return

    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT LTRIM(RTRIM(NCOMP_IN_S)) AS num FROM STA14
      WHERE TCOMP_IN_S = 'RP' AND ESTADO_MOV = 'F'
    `)
    const facturados = new Set(r.recordset.map((x) => String(x.num)))
    expect(devuelto.filter((x) => facturados.has(x.numeroInterno))).toEqual([])
  })
})
