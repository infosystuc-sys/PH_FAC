import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { obtenerDetalleEn } from '@/server/app/detalle'
import {
  agregarOcEn,
  quitarOcEn,
  ocsDelComprobanteEn,
  renglonesSinOcEn,
} from '@/server/app/ordenCompra'
import { buscarOcPendientes, type OrdenCompra } from '@/server/tango/ordenesCompra'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Escribe solo en PHF_RENGLON / PHF_RENGLON_PDF (tablas propias) y dentro de
 * conRollback. De Tango solo lee: las OC son reales, no se crean ni se tocan.
 */
async function unProveedorConOc(minimoDeOc = 1) {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PROVEE)) AS cod
    FROM CPA35 h JOIN CPA36 g ON g.N_ORDEN_CO = h.N_ORDEN_CO
    WHERE ISNULL(g.PENDIENTE_FACTURAR, 0) > 0
    GROUP BY h.COD_PROVEE
    HAVING COUNT(DISTINCT h.N_ORDEN_CO) >= ${minimoDeOc}
    ORDER BY COUNT(*) DESC
  `)
  if (r.recordset.length === 0) return null
  const cod = String(r.recordset[0].cod)
  return { codProvee: cod, ocs: await buscarOcPendientes(cod) }
}

/** El detalle que la IA leyó del PDF: es contra esto que se empareja la OC. */
async function renglonesPdf(
  tx: sql.Transaction,
  id: number,
  lineas: { codigo: string; cantidad: string }[],
) {
  let orden = 0
  for (const l of lineas) {
    orden += 1
    await tx
      .request()
      .input('id', sql.Int, id)
      .input('orden', sql.Int, orden)
      .input('cod', sql.NVarChar(60), l.codigo)
      .input('cant', sql.NVarChar(40), l.cantidad)
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, CANTIDAD)
        VALUES (@id, @orden, @cod, @cant)
      `)
  }
}

/** Un renglón de la OC que sirva de "artículo que la factura cobra". */
function primerRenglon(oc: OrdenCompra) {
  return oc.renglones[0]
}

describe('agregarOcEn', () => {
  it('trae SOLO los articulos que la factura cobra, no la OC entera', async () => {
    // Es el cambio del 2026-09-07: antes traia los N renglones pendientes de
    // la orden y el operador tenia que borrar los que la factura no cobraba.
    const p = await unProveedorConOc()
    const oc = p!.ocs.find((o) => o.renglones.length > 1) ?? p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])

      const r = await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(r.agregados).toBe(1)
      expect(r.sinEmparejar).toBe(0)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      expect(d.renglones[0].codigo).toBe(uno.codArticu)
    })
  })

  it('la cantidad es la que factura el proveedor, no lo pendiente de la OC', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(Number(d.renglones[0].cantidad)).toBeCloseTo(1, 4)
      // El precio si sale de la OC, que es el pactado, y lo pendiente se
      // congela para poder mostrarlo despues.
      expect(Number(d.renglones[0].precioUnitario)).toBeCloseTo(uno.precio, 2)
      expect(Number(d.renglones[0].ocPendiente)).toBeCloseTo(uno.pendienteFacturar, 2)
    })
  })

  it('guarda la clave que despues va a CPA_OC_FACTURA', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones[0].ocNOrdenCo).toBe(oc.nOrdenCo)
      expect(d.renglones[0].ocTalonario).toBe(oc.talonario)
      expect(d.renglones[0].ocNRenglOc).toBe(uno.nRenglOc)
    })
  })

  it('cuenta los renglones de la factura que esta OC no tiene', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: uno.codArticu, cantidad: '1' },
        { codigo: 'NO-ESTA-EN-NINGUNA-OC', cantidad: '5' },
      ])

      const r = await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(r.agregados).toBe(1)
      expect(r.sinEmparejar).toBe(1)
    })
  })

  it('imputar OTRA orden agrega, no reemplaza: una factura puede partirse', async () => {
    const p = await unProveedorConOc(2)
    if (!p) return // ningun proveedor con dos OC hoy
    const [a, b] = p.ocs

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: primerRenglon(a).codArticu, cantidad: '1' },
        { codigo: primerRenglon(b).codArticu, cantidad: '1' },
      ])

      await agregarOcEn(tx, id, a.nOrdenCo, p.codProvee)
      await agregarOcEn(tx, id, b.nOrdenCo, p.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(2)
      expect(new Set(d.renglones.map((r) => r.ocNOrdenCo)).size).toBe(2)
      // ORDEN es UNIQUE por comprobante: la segunda sigue desde donde quedo
      // la primera en vez de arrancar de 1 y chocar.
      expect(new Set(d.renglones.map((r) => r.orden)).size).toBe(2)
    })
  })

  it('imputar LA MISMA orden dos veces no duplica nada', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]
    const uno = primerRenglon(oc)

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: uno.codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
    })
  })

  it('no imputa sin renglones leidos del PDF: no habria con que emparejar', async () => {
    const p = await unProveedorConOc()
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(agregarOcEn(tx, id, p!.ocs[0].nOrdenCo, p!.codProvee)).rejects.toThrow(
        /renglones de la factura/i,
      )
    })
  })

  it('falla con un numero de OC que no existe', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(agregarOcEn(tx, id, 'NO EXISTE', null)).rejects.toThrow(/no existe/)
    })
  })

  it('deja la entrada de auditoria con el numero de OC', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria.some((a) => a.texto.includes(oc.nOrdenCo.trim()))).toBe(true)
    })
  })
})

describe('quitarOcEn', () => {
  it('saca la orden con los renglones que trajo', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      expect(await quitarOcEn(tx, id, oc.nOrdenCo)).toBe(1)
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([])
    })
  })
})

describe('ocsDelComprobanteEn', () => {
  it('arranca vacio y despues trae la imputada', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([])

      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)
      expect(await ocsDelComprobanteEn(tx, id)).toEqual([oc.nOrdenCo])
    })
  })
})

describe('renglonesSinOcEn', () => {
  it('lista lo que la factura cobra y ninguna orden imputada cubre', async () => {
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [
        { codigo: primerRenglon(oc).codArticu, cantidad: '1' },
        { codigo: 'NO-ESTA-EN-NINGUNA-OC', cantidad: '5' },
      ])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      const faltan = await renglonesSinOcEn(tx, id, p!.codProvee)
      expect(faltan).toHaveLength(1)
      expect(faltan[0].codigo).toBe('NO-ESTA-EN-NINGUNA-OC')
    })
  })

  it('queda vacio cuando todos los renglones tienen su orden', async () => {
    // Es la condicion para poder registrar -- decision del usuario.
    const p = await unProveedorConOc()
    const oc = p!.ocs[0]

    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await renglonesPdf(tx, id, [{ codigo: primerRenglon(oc).codArticu, cantidad: '1' }])
      await agregarOcEn(tx, id, oc.nOrdenCo, p!.codProvee)

      expect(await renglonesSinOcEn(tx, id, p!.codProvee)).toEqual([])
    })
  })
})
