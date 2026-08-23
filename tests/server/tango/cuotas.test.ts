import { describe, it, expect, afterAll } from 'vitest'
import { previsualizarCuotasEn, escribirCuotasEn } from '@/server/tango/cuotas'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'

afterAll(async () => {
  await cerrarPool()
})

describe('previsualizarCuotasEn', () => {
  it('arma 6 cuotas para una condicion real de 6 vencimientos, sumando exacto al total', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      // COD_CONDIC=4, "CTA CTE 30-60-90-120-150-180 DIAS": 6 renglones reales
      // en RENGLON_CONDICION_COMPRA/CPA49, 16.66% x5 + 16.7% el ultimo.
      await guardarCampoEn(tx, id, 'condcompra', '4')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'total', '10.000,00')

      const preview = await previsualizarCuotasEn(tx, id)

      expect(preview.condicionDescripcion).toBe('CTA CTE 30-60-90-120-150-180 DIAS')
      expect(preview.cuotas).toHaveLength(6)
      expect(preview.cuotas.map((c) => c.nroCuota)).toEqual([1, 2, 3, 4, 5, 6])
      expect(preview.cuotas.map((c) => c.diasVencimiento)).toEqual([30, 60, 90, 120, 150, 180])
      expect(preview.cuotas.map((c) => c.porcentaje)).toEqual([16.66, 16.66, 16.66, 16.66, 16.66, 16.7])

      // Emision 01/06/2026 + 30 dias = 01/07/2026.
      expect(preview.cuotas[0].fechaVencimiento.getUTCFullYear()).toBe(2026)
      expect(preview.cuotas[0].fechaVencimiento.getUTCMonth()).toBe(6) // julio, 0-indexado.
      expect(preview.cuotas[0].fechaVencimiento.getUTCDate()).toBe(1)

      const sumaImportes = preview.cuotas.reduce((a, c) => a + c.importe, 0)
      expect(Math.round(sumaImportes * 100) / 100).toBe(10000)
      expect(preview.totalCuotas).toBe(10000)
      expect(preview.totalComprobante).toBe(10000)
      expect(preview.cierra).toBe(true)
    })
  })

  it('no arma nada si todavia no hay condicion de compra elegida', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'total', '10.000,00')

      const preview = await previsualizarCuotasEn(tx, id)

      expect(preview.cuotas).toHaveLength(0)
      expect(preview.cierra).toBe(false)
    })
  })

  it('no arma nada si el total todavia es cero', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'condcompra', '4')

      const preview = await previsualizarCuotasEn(tx, id)

      expect(preview.cuotas).toHaveLength(0)
      expect(preview.cierra).toBe(false)
    })
  })
})

describe('escribirCuotasEn', () => {
  /** Un N_COMP que no puede colisionar con ninguno real. */
  function nCompFalso(offset: number): string {
    return `T${(900000000 + (Date.now() % 100000) + offset).toString().slice(0, 13)}`
  }

  it('graba un CPA54 por cuota, con ID_CPA04 enlazado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'condcompra', '4')
      await guardarCampoEn(tx, id, 'fecha', '01/06/2026')
      await guardarCampoEn(tx, id, 'total', '10.000,00')

      const nComp = nCompFalso(0)
      const idCpa04Falso = 999999
      const preview = await escribirCuotasEn(tx, id, '010151', 'FAC', nComp, idCpa04Falso)

      expect(preview.cuotas).toHaveLength(6)

      const filas = await tx.request().input('n', nComp).query(`
        SELECT FECHA_VTO, IMPORT_VTO, ESTADO_VTO, ID_CPA04 FROM CPA54 WHERE N_COMP = @n ORDER BY FECHA_VTO
      `)
      expect(filas.recordset).toHaveLength(6)
      for (const fila of filas.recordset as { ESTADO_VTO: string; ID_CPA04: number }[]) {
        expect(fila.ESTADO_VTO).toBe('PEN')
        expect(fila.ID_CPA04).toBe(idCpa04Falso)
      }
      const sumaGrabada = (filas.recordset as { IMPORT_VTO: string }[]).reduce(
        (a, f) => a + Number(f.IMPORT_VTO),
        0,
      )
      expect(Math.round(sumaGrabada * 100) / 100).toBe(10000)
    })
  })

  it('rechaza si la condicion de compra no existe', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'condcompra', '9999')
      await guardarCampoEn(tx, id, 'total', '10.000,00')

      const nComp = nCompFalso(1)
      await expect(escribirCuotasEn(tx, id, '010151', 'FAC', nComp, 999999)).rejects.toThrow(/no cierran/)

      const filas = await tx.request().input('n', nComp).query(`SELECT COUNT(*) AS n FROM CPA54 WHERE N_COMP = @n`)
      expect(Number(filas.recordset[0].n)).toBe(0)
    })
  })
})
