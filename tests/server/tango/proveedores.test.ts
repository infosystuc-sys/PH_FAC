import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { buscarProveedorPorCuit, buscarProveedoresPorRazonSocial } from '@/server/tango/proveedores'
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

describe('buscarProveedoresPorRazonSocial', () => {
  it('encuentra por substring, sin distinguir mayusculas', async () => {
    const frag = razonReal.slice(0, 5).toLowerCase()
    const r = await buscarProveedoresPorRazonSocial(frag)
    expect(r.map((p) => p.codProvee)).toContain(codReal)
  })

  it('respeta el limite', async () => {
    const r = await buscarProveedoresPorRazonSocial(razonReal.slice(0, 2), 3)
    expect(r.length).toBeLessThanOrEqual(3)
  })

  it('devuelve vacio con texto de menos de dos caracteres', async () => {
    const r = await buscarProveedoresPorRazonSocial('a')
    expect(r).toEqual([])
  })
})
