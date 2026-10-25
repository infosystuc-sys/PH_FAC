import { describe, it, expect, afterAll } from 'vitest'
import { getPool, cerrarPool } from '@/server/db/pool'
import { buscarOcPendientes, buscarOcPorNumero } from '@/server/tango/ordenesCompra'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Todo de lectura: este modulo no escribe en Tango. Las pruebas van contra
 * las OC reales de la base, sin fixtures propios -- igual que remitos.test.ts.
 */

/** Un proveedor que hoy tenga al menos una OC con pendiente de facturar. */
async function proveedorConOc(): Promise<string | null> {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS cod
    FROM CPA35 h JOIN CPA36 r ON r.N_ORDEN_CO = h.N_ORDEN_CO
    WHERE ISNULL(r.PENDIENTE_FACTURAR, 0) > 0
    GROUP BY h.COD_PROVEE
    ORDER BY COUNT(*) DESC
  `)
  return r.recordset.length > 0 ? String(r.recordset[0].cod) : null
}

describe('buscarOcPendientes', () => {
  it('devuelve las OC del proveedor, todas con algo pendiente', async () => {
    const prov = await proveedorConOc()
    expect(prov).not.toBeNull()

    const ocs = await buscarOcPendientes(prov!)
    expect(ocs.length).toBeGreaterThan(0)

    for (const oc of ocs) {
      expect(oc.codProvee).toBe(prov)
      expect(oc.renglones.length).toBeGreaterThan(0)
      // El filtro es por renglon: no puede colarse uno ya facturado entero.
      for (const r of oc.renglones) expect(r.pendiente).toBeGreaterThan(0)
    }
  })

  it('trae el estado con su descripcion legible', async () => {
    const prov = await proveedorConOc()
    const ocs = await buscarOcPendientes(prov!)
    // Los estados que la base tiene con pendiente son 3 (Emitida), 8
    // (Emitida y cerrada) y 10 (Cumplida) -- medido el 2026-09-06.
    expect(ocs[0].descripcionEstado.length).toBeGreaterThan(0)
    expect(ocs[0].estado).toBeGreaterThan(0)
  })

  it('el pendiente nunca supera lo pedido', async () => {
    const prov = await proveedorConOc()
    for (const oc of await buscarOcPendientes(prov!)) {
      for (const r of oc.renglones) {
        expect(r.pendiente).toBeLessThanOrEqual(r.cantidadPedida)
        // Es <= y no ==. Medido el 2026-09-11 sobre los 170 renglones con
        // pendiente: los 170 cumplen esta desigualdad, y 168 cumplen ademas
        // la igualdad. Los dos que no son renglones ya recibidos en parte,
        // donde Tango bajo el pendiente a lo recibido: la OC 0000100000021
        // tiene 20 pedidas, 16 recibidas, 0 facturadas y 16 pendientes. El
        // test afirmaba la igualdad y fallaba con esos dos -- la igualdad era
        // cierta de los datos de entonces, no de la regla.
        expect(r.pendiente).toBeLessThanOrEqual(r.cantidadPedida - r.cantidadFacturada)
      }
    }
  })

  it('no devuelve nada sin proveedor, sin pegarle a la base', async () => {
    expect(await buscarOcPendientes('')).toEqual([])
    expect(await buscarOcPendientes('   ')).toEqual([])
  })

  it('no mezcla las OC de un proveedor con las de otro', async () => {
    const prov = await proveedorConOc()
    const ocs = await buscarOcPendientes(prov!)
    const numeros = new Set(ocs.map((o) => o.nOrdenCo))

    // Un codigo de proveedor que no existe no puede traer las de nadie.
    expect(await buscarOcPendientes('ZZZZZZ')).toEqual([])
    expect(numeros.size).toBe(ocs.length)
  })
})

describe('buscarOcPorNumero', () => {
  it('encuentra una OC real por su numero', async () => {
    const prov = await proveedorConOc()
    const ocs = await buscarOcPendientes(prov!)
    const esperada = ocs[0]

    const leida = await buscarOcPorNumero(esperada.nOrdenCo)
    expect(leida).not.toBeNull()
    expect(leida!.nOrdenCo).toBe(esperada.nOrdenCo)
    expect(leida!.talonario).toBe(esperada.talonario)
    expect(leida!.renglones.length).toBe(esperada.renglones.length)
  })

  it('devuelve null si el numero no existe', async () => {
    expect(await buscarOcPorNumero('NO EXISTE')).toBeNull()
    expect(await buscarOcPorNumero('')).toBeNull()
  })

  it('el talonario es el de CPA35, que es el que va a CPA_OC_FACTURA', async () => {
    // Verificado sobre las 9.975 filas reales de CPA_OC_FACTURA:
    // TALONARIO_OC coincide siempre con CPA35.TALONARIO.
    const prov = await proveedorConOc()
    const oc = (await buscarOcPendientes(prov!))[0]
    const pool = await getPool()
    const r = await pool.request().input('oc', oc.nOrdenCo).query(`
      SELECT TALONARIO FROM CPA35 WHERE N_ORDEN_CO = @oc
    `)
    expect(oc.talonario).toBe(Number(r.recordset[0].TALONARIO))
  })
})
