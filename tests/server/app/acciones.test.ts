import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { rm } from 'node:fs/promises'
import { conRollback } from '@/server/db/tx'
import { cerrarPool, getPool } from '@/server/db/pool'
import { importarComprobanteEn, importarComprobantes, elegirProveedorEn } from '@/server/app/acciones'
import { obtenerDetalleEn } from '@/server/app/detalle'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
  await cerrarPool()
})

const PDF = Buffer.from('%PDF-1.4 de prueba')

describe('importarComprobanteEn', () => {
  it('crea el comprobante en procesando', async () => {
    await conRollback(async (tx) => {
      const id = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ESTADO, ARCHIVO_NOMBRE, ARCHIVO_HASH, ARCHIVO_RUTA, INTENTOS FROM PHF_COMPROBANTE WHERE ID = @id')
      const c = r.recordset[0]
      creados.push(String(c.ARCHIVO_RUTA))

      expect(c.ESTADO).toBe('procesando')
      expect(c.ARCHIVO_NOMBRE).toBe('factura.pdf')
      expect(String(c.ARCHIVO_HASH)).toHaveLength(64)
      expect(c.INTENTOS).toBe(0)
    })
  })

  it('deja la entrada de auditoria de la importacion', async () => {
    await conRollback(async (tx) => {
      const id = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
      creados.push(String(r.recordset[0].ARCHIVO_RUTA))

      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria[0].texto).toBe('PDF importado desde carga manual')
    })
  })

  it('permite importar dos veces el mismo PDF', async () => {
    // La deteccion de duplicados es de la Fase 3 y va por proveedor + tipo
    // + numero, no por hash del archivo. Importar dos veces no se bloquea.
    await conRollback(async (tx) => {
      const a = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      const b = await importarComprobanteEn(tx, 'factura.pdf', PDF)
      expect(a).not.toBe(b)

      for (const id of [a, b]) {
        const r = await tx.request().input('id', sql.Int, id)
          .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
        creados.push(String(r.recordset[0].ARCHIVO_RUTA))
      }
    })
  })
})

describe('importarComprobantes', () => {
  it('no deja ningun comprobante importado si un archivo del lote supera el limite de tamano', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')

    const fd = new FormData()
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))
    fd.append(
      'archivos',
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'grande.pdf', { type: 'application/pdf' }),
    )

    // El archivo grande es el segundo del lote: si la validacion no fuera
    // previa a la importacion, "chico.pdf" ya habria quedado commiteado en
    // 'procesando' antes de que el loop llegara a rechazar "grande.pdf".
    await expect(importarComprobantes(fd)).rejects.toThrow('grande.pdf supera los 10 MB.')

    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un lote con un archivo que no es PDF, sin importar nada', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')

    const fd = new FormData()
    fd.append('archivos', new File([PDF], 'chico.pdf', { type: 'application/pdf' }))
    fd.append('archivos', new File([Buffer.from('no es un pdf')], 'no-es-pdf.txt', { type: 'text/plain' }))

    await expect(importarComprobantes(fd)).rejects.toThrow('no-es-pdf.txt no es un PDF.')

    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })
})

describe('elegirProveedorEn', () => {
  it('guarda codprovee, desnormaliza RAZON_SOCIAL/COD_PROVEE y audita', async () => {
    // Se ejercita `elegirProveedorEn(tx, ...)` -- no el wrapper `elegirProveedor`,
    // que abre su propia conexión de pool -- para que corra dentro de la
    // misma transacción que insertó el comprobante de prueba. Si se usara el
    // pool real acá, el UPDATE (y el INSERT en PHF_AUDITORIA, que tiene FK a
    // PHF_COMPROBANTE) quedarían esperando el lock de esta transacción, que a
    // su vez no comitea hasta que el test termina: un deadlock por diseño del
    // test, no una carrera real. Mismo motivo por el que se lee con `tx` en
    // vez de `getPool()`/`obtenerDetalle`.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await elegirProveedorEn(tx, id, '010151', 'AMX ARGENTINA SOCIEDAD ANONIMA', true)

      const detalle = await obtenerDetalleEn(tx, id)
      const campo = detalle.campos.find((c) => c.clave === 'codprovee')
      expect(campo?.valorFinal).toBe('010151')
      expect(campo?.corregido).toBe(true)

      const fila = await tx
        .request()
        .input('id', sql.Int, id)
        .query(`SELECT COD_PROVEE, RAZON_SOCIAL FROM PHF_COMPROBANTE WHERE ID=@id`)
      expect(fila.recordset[0].COD_PROVEE).toBe('010151')
      expect(fila.recordset[0].RAZON_SOCIAL).toBe('AMX ARGENTINA SOCIEDAD ANONIMA')

      expect(detalle.auditoria.some((a) => a.texto.includes('AMX'))).toBe(true)
    })
  })
})
