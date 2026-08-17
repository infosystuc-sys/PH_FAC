import { describe, it, expect, afterAll } from 'vitest'
import { cerrarPool, getPool } from '@/server/db/pool'
import {
  buscarConceptoProveedor,
  buscarConceptoTarjeta,
  conceptoDelComprobante,
  COD_CONCEPTO_TARJETA,
} from '@/server/tango/conceptos'

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

describe('buscarConceptoTarjeta', () => {
  it('encuentra el concepto fijo de comisiones de tarjeta en CPA45', async () => {
    // Si esto falla, el registro de toda liquidacion de tarjeta va a
    // explotar contra un COD_CONCEP que no existe: el INSERT a CPA47
    // apunta a este codigo.
    const r = await buscarConceptoTarjeta()
    expect(r).not.toBeNull()
    expect(r!.codConcepto).toBe(COD_CONCEPTO_TARJETA)
    expect(r!.descripcion).toMatch(/comision/i)
  })

  it('lee la descripcion de Tango en vez de tenerla hardcodeada', async () => {
    // Si la renombran en Tango, la pantalla tiene que decir lo que dice
    // Tango. Se verifica contra el maestro, no contra un literal.
    const r = await buscarConceptoTarjeta()
    const pool = await getPool()
    const q = await pool.request().input('c', COD_CONCEPTO_TARJETA).query(
      `SELECT LTRIM(RTRIM(ISNULL(DESC_CONCE,''))) AS d FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @c`,
    )
    expect(r!.descripcion).toBe(String(q.recordset[0].d))
  })
})

describe('conceptoDelComprobante', () => {
  it('en tarjeta devuelve el fijo, sin mirar el proveedor', async () => {
    const conProv = await conceptoDelComprobante('tarjeta', '010151')
    const sinProv = await conceptoDelComprobante('tarjeta', null)
    expect(conProv?.codConcepto).toBe(COD_CONCEPTO_TARJETA)
    // El proveedor de una liquidacion es la tarjeta o el banco, y su ficha
    // puede tener otro concepto o ninguno: no tiene que influir.
    expect(sinProv?.codConcepto).toBe(COD_CONCEPTO_TARJETA)
  })

  it('en conceptos devuelve el de la ficha del proveedor', async () => {
    const r = await conceptoDelComprobante('conceptos', '010151')
    expect(r?.codConcepto).toBe('712')
  })

  it('en articulos no hay concepto: se imputa por renglon', async () => {
    expect(await conceptoDelComprobante('articulos', '010151')).toBeNull()
  })
})
