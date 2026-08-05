import { describe, it, expect, afterAll } from 'vitest'
import {
  listarCondicionesCompra,
  buscarCondicionCompra,
} from '@/server/tango/condicionesCompra'
import { cerrarPool } from '@/server/db/pool'

afterAll(async () => {
  await cerrarPool()
})

describe('listarCondicionesCompra', () => {
  it('trae las condiciones definidas en la base', async () => {
    const r = await listarCondicionesCompra()
    expect(r.length).toBeGreaterThan(0)
  })

  it('viene ordenada por codigo', async () => {
    const codigos = (await listarCondicionesCompra()).map((c) => c.codigo)
    expect(codigos).toEqual([...codigos].sort((a, b) => a - b))
  })

  it('no repite codigos', async () => {
    const codigos = (await listarCondicionesCompra()).map((c) => c.codigo)
    expect(new Set(codigos).size).toBe(codigos.length)
  })

  it('todas tienen descripcion y cuotas no negativas', async () => {
    for (const c of await listarCondicionesCompra()) {
      expect(c.descripcion).not.toBe('')
      expect(c.cuotas).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('buscarCondicionCompra', () => {
  it('encuentra una condicion real por su codigo', async () => {
    const [primera] = await listarCondicionesCompra()
    const c = await buscarCondicionCompra(primera.codigo)
    expect(c).toEqual(primera)
  })

  it('devuelve null cuando el codigo no existe', async () => {
    // 9999 no entra en COD_CONDIC, que es ENTERO_TG (smallint).
    const c = await buscarCondicionCompra(9999)
    expect(c).toBeNull()
  })

  it('devuelve null para el codigo 0, que es "sin condicion"', async () => {
    // 640 de los 666 proveedores de CPA01 tienen COND_COMPR = 0 y no hay
    // ninguna fila con ese codigo. Si esto empezara a devolver algo, el
    // supuesto de que 0 significa "ninguna" dejo de valer.
    const c = await buscarCondicionCompra(0)
    expect(c).toBeNull()
  })

  it('devuelve null con un codigo no entero', async () => {
    const c = await buscarCondicionCompra(1.5)
    expect(c).toBeNull()
  })
})
