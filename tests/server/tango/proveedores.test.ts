import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import {
  buscarProveedorPorCuit,
  buscarProveedoresPorCuit,
  buscarProveedoresPorRazonSocial,
} from '@/server/tango/proveedores'
import { getPool, cerrarPool } from '@/server/db/pool'

let cuitReal: string
let razonReal: string
let codReal: string

beforeAll(async () => {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 COD_PROVEE, NOM_PROVEE, N_CUIT
    FROM CPA01
    WHERE LEN(REPLACE(REPLACE(ISNULL(N_CUIT,''), '-', ''), ' ', '')) = 11
    ORDER BY COD_PROVEE
  `)
  const p = r.recordset[0]
  codReal = String(p.COD_PROVEE).trim()
  razonReal = String(p.NOM_PROVEE).trim()
  cuitReal = String(p.N_CUIT).trim()
})

afterAll(async () => {
  await cerrarPool()
})

describe('buscarProveedorPorCuit', () => {
  it('encuentra un proveedor real por su CUIT', async () => {
    const p = await buscarProveedorPorCuit(cuitReal)
    expect(p).not.toBeNull()
    expect(p!.codProvee).toBe(codReal)
  })

  it('encuentra el mismo proveedor con el CUIT sin guiones', async () => {
    const p = await buscarProveedorPorCuit(cuitReal.replace(/\D/g, ''))
    expect(p!.codProvee).toBe(codReal)
  })

  it('devuelve null cuando el CUIT no existe', async () => {
    const p = await buscarProveedorPorCuit('99-99999999-9')
    expect(p).toBeNull()
  })

  it('devuelve null cuando el CUIT esta mal formado', async () => {
    const p = await buscarProveedorPorCuit('123')
    expect(p).toBeNull()
  })
})

describe('buscarProveedoresPorCuit', () => {
  it('devuelve un array con el unico match cuando el CUIT no esta duplicado', async () => {
    // CUIT real de AMX ARGENTINA, usado en otros tests de la suite.
    const r = await buscarProveedoresPorCuit('30-66328849-7')
    expect(r.length).toBe(1)
    expect(r[0].razonSocial).toContain('AMX')
  })

  it('devuelve un array vacio si no matchea ningun proveedor', async () => {
    const r = await buscarProveedoresPorCuit('20-11111111-1')
    expect(r).toEqual([])
  })

  it('devuelve mas de un resultado para un CUIT duplicado real de la base', async () => {
    // Descubierto en la revision final de Fase 1: hay 7 CUIT duplicados en
    // CPA01. Se busca uno en vez de hardcodear un CUIT: la base es real y
    // el conjunto de duplicados puede cambiar.
    const dup = await getPool().then((p) => p.request().query(`
      SELECT TOP 1 REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','') AS cuit
      FROM CPA01
      WHERE N_CUIT IS NOT NULL AND N_CUIT <> ''
      GROUP BY REPLACE(REPLACE(REPLACE(N_CUIT,'-',''),' ',''),'.','')
      HAVING COUNT(*) > 1
    `))
    if (dup.recordset.length === 0) return // no hay duplicados hoy: no hay nada que probar
    const r = await buscarProveedoresPorCuit(dup.recordset[0].cuit)
    expect(r.length).toBeGreaterThan(1)
  })
})

describe('buscarProveedoresPorRazonSocial', () => {
  it('encuentra por substring, sin distinguir mayusculas', async () => {
    const frag = razonReal.slice(0, 5).toLowerCase()
    const r = await buscarProveedoresPorRazonSocial(frag)
    expect(r.map((p) => p.codProvee)).toContain(codReal)
  })

  it('respeta el limite', async () => {
    // 'SA' matchea mas de 100 proveedores en CPA01 (verificado contra la
    // base). Si buscarProveedoresPorRazonSocial tuviera un bug que la hiciera
    // devolver [], toBeLessThanOrEqual(3) pasaria igual; toBe(3) no.
    const r = await buscarProveedoresPorRazonSocial('SA', 3)
    expect(r.length).toBe(3)
  })

  it('devuelve vacio con texto de menos de dos caracteres', async () => {
    const r = await buscarProveedoresPorRazonSocial('a')
    expect(r).toEqual([])
  })
})
