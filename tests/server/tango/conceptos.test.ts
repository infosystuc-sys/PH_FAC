import { describe, it, expect, afterAll } from 'vitest'
import { cerrarPool } from '@/server/db/pool'
import { buscarConceptoProveedor } from '@/server/tango/conceptos'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarConceptoProveedor', () => {
  it('encuentra el concepto real de un proveedor cargado (010151, AMX/Claro)', async () => {
    const r = await buscarConceptoProveedor('010151')
    expect(r).not.toBeNull()
    expect(r!.codConcepto).toBe('712')
    expect(r!.descripcion).toBe('TELEFONOS LOCALES')
  })

  it('devuelve null si el proveedor no tiene concepto configurado', async () => {
    const r = await buscarConceptoProveedor('999999')
    expect(r).toBeNull()
  })
})
