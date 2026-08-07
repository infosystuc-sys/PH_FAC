import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { validarComprobanteEn } from '@/server/app/validaciones'

afterAll(async () => {
  await cerrarPool()
})

describe('validarComprobanteEn', () => {
  it('proveedor en error y bloqueante si el CUIT no matchea ningun proveedor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', '20-11111111-1')
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '1')
      await guardarCampoEn(tx, id, 'nro', '1')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
      expect(v.candidatosProveedor).toEqual([])
    })
  })

  it('proveedor ok y sin duplicado cuando el CUIT matchea uno solo y el N_COMP no existe en CPA04', async () => {
    await conRollback(async (tx) => {
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      const cuit = String(cuitAmx.recordset[0].N_CUIT)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', cuit)
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99999')
      await guardarCampoEn(tx, id, 'nro', '99999999')
      await guardarCampoEn(tx, id, 'total', '100,00')
      await guardarCampoEn(tx, id, 'neto', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.proveedor.estado).toBe('ok')
      expect(v.duplicado.estado).toBe('ok')
      expect(v.totales.estado).toBe('ok')
      expect(v.bloqueante).toBe(false)
    })
  })

  it('duplicado en error si el N_COMP ya existe en CPA04 para ese proveedor', async () => {
    await conRollback(async (tx) => {
      const existente = await tx.request().query(`
        SELECT TOP 1 c.COD_PROVEE, c.N_COMP, p.N_CUIT
        FROM CPA04 c JOIN CPA01 p ON p.COD_PROVEE = c.COD_PROVEE
        WHERE c.T_COMP = 'FAC' AND p.N_CUIT IS NOT NULL AND p.N_CUIT <> ''
        ORDER BY c.NCOMP_IN_C DESC
      `)
      const fila = existente.recordset[0]
      const nComp = String(fila.N_COMP).trim()
      const letra = nComp[0]
      const ptovta = nComp.slice(1, 6)
      const nro = nComp.slice(6)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', String(fila.N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', `FAC ${letra}`)
      await guardarCampoEn(tx, id, 'ptovta', ptovta)
      await guardarCampoEn(tx, id, 'nro', nro)
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
      expect(v.bloqueante).toBe(true)
    })
  })

  it('duplicado en error si ya existe otro PHF_COMPROBANTE con el mismo proveedor+tipo+ptovta+numero', async () => {
    await conRollback(async (tx) => {
      const otro = await insertarComprobantePrueba(tx, {
        estado: 'confirmado', tipo: 'FAC A', puntoVenta: '00001', numero: '00000001',
      })
      await tx.request().input('id', sql.Int, otro).input('cp', sql.VarChar(20), '010151')
        .query(`UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cp WHERE ID = @id`)

      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '00001')
      await guardarCampoEn(tx, id, 'nro', '00000001')
      await guardarCampoEn(tx, id, 'total', '100,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.duplicado.estado).toBe('error')
    })
  })

  it('totales en advertencia si no cierran, sin bloquear la confirmacion', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const cuitAmx = await tx.request().query(`SELECT TOP 1 N_CUIT FROM CPA01 WHERE COD_PROVEE = '010151'`)
      await guardarCampoEn(tx, id, 'cuit', String(cuitAmx.recordset[0].N_CUIT))
      await guardarCampoEn(tx, id, 'tipo', 'FAC A')
      await guardarCampoEn(tx, id, 'ptovta', '99998')
      await guardarCampoEn(tx, id, 'nro', '99999998')
      await guardarCampoEn(tx, id, 'neto', '100,00')
      await guardarCampoEn(tx, id, 'total', '999,00')

      const v = await validarComprobanteEn(tx, id)
      expect(v.totales.estado).toBe('advertencia')
      expect(v.bloqueante).toBe(false)
    })
  })
})
