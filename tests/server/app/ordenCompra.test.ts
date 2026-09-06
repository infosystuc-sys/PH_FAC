import { describe, it, expect, afterAll } from 'vitest'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { obtenerDetalleEn } from '@/server/app/detalle'
import { asignarOcEn, ocDelComprobanteEn } from '@/server/app/ordenCompra'
import { buscarOcPendientes } from '@/server/tango/ordenesCompra'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Escribe solo en PHF_RENGLON (tabla propia) y dentro de conRollback. De
 * Tango solo lee: las OC son reales, no se crean ni se tocan.
 */
async function unaOcReal() {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS cod
    FROM CPA35 h JOIN CPA36 g ON g.N_ORDEN_CO = h.N_ORDEN_CO
    WHERE ISNULL(g.PENDIENTE_FACTURAR, 0) > 0
    GROUP BY h.COD_PROVEE ORDER BY COUNT(*) DESC
  `)
  const ocs = await buscarOcPendientes(String(r.recordset[0].cod))
  return ocs[0]
}

describe('asignarOcEn', () => {
  it('deja un renglon por cada linea pendiente de la OC', async () => {
    const oc = await unaOcReal()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuantos = await asignarOcEn(tx, id, oc.nOrdenCo)

      expect(cuantos).toBe(oc.renglones.length)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(oc.renglones.length)
    })
  })

  it('guarda la clave que despues va a CPA_OC_FACTURA', async () => {
    const oc = await unaOcReal()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await asignarOcEn(tx, id, oc.nOrdenCo)

      const d = await obtenerDetalleEn(tx, id)
      for (const r of d.renglones) {
        expect(r.ocNOrdenCo).toBe(oc.nOrdenCo)
        expect(r.ocTalonario).toBe(oc.talonario)
        expect(r.ocNRenglOc).not.toBeNull()
      }
      // Los renglones de la OC, en orden, sin repetir ninguno.
      const enOc = d.renglones.map((r) => r.ocNRenglOc)
      expect(new Set(enOc).size).toBe(enOc.length)
    })
  })

  it('la cantidad arranca en lo pendiente de facturar', async () => {
    const oc = await unaOcReal()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await asignarOcEn(tx, id, oc.nOrdenCo)

      const d = await obtenerDetalleEn(tx, id)
      for (const r of d.renglones) {
        const enOc = oc.renglones.find((x) => x.nRenglOc === r.ocNRenglOc)!
        expect(Number(r.cantidad)).toBeCloseTo(enOc.pendienteFacturar, 2)
        // Se congela tambien lo pendiente, para poder mostrarlo despues
        // aunque la OC ya no aparezca en la lista.
        expect(Number(r.ocPendiente)).toBeCloseTo(enOc.pendienteFacturar, 2)
        // El codigo es el de Tango, con el que se graba CPA46.
        expect(r.codigo).toBe(enOc.codArticu)
      }
    })
  })

  it('elegir otra OC reemplaza, no acumula', async () => {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS cod
      FROM CPA35 h JOIN CPA36 g ON g.N_ORDEN_CO = h.N_ORDEN_CO
      WHERE ISNULL(g.PENDIENTE_FACTURAR, 0) > 0
      GROUP BY h.COD_PROVEE HAVING COUNT(DISTINCT h.N_ORDEN_CO) > 1
      ORDER BY COUNT(*) DESC
    `)
    if (r.recordset.length === 0) return // ningun proveedor con dos OC hoy

    const ocs = await buscarOcPendientes(String(r.recordset[0].cod))
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await asignarOcEn(tx, id, ocs[0].nOrdenCo)
      await asignarOcEn(tx, id, ocs[1].nOrdenCo)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(ocs[1].renglones.length)
      for (const x of d.renglones) expect(x.ocNOrdenCo).toBe(ocs[1].nOrdenCo)
    })
  })

  it('deja la entrada de auditoria con el numero de OC', async () => {
    const oc = await unaOcReal()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await asignarOcEn(tx, id, oc.nOrdenCo)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes(oc.nOrdenCo.trim()))).toBe(true)
    })
  })

  it('falla con un numero de OC que no existe', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(asignarOcEn(tx, id, 'NO EXISTE')).rejects.toThrow(/no existe/)
    })
  })
})

describe('ocDelComprobanteEn', () => {
  it('devuelve null mientras no se imputo ninguna', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await ocDelComprobanteEn(tx, id)).toBeNull()
    })
  })

  it('devuelve la OC imputada', async () => {
    const oc = await unaOcReal()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await asignarOcEn(tx, id, oc.nOrdenCo)
      expect(await ocDelComprobanteEn(tx, id)).toBe(oc.nOrdenCo)
    })
  })
})
