import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import {
  guardarExtraccionEn,
  obtenerDetalleEn,
  guardarCampoEn,
  auditarEn,
  buscarComprobantePorHashEn,
} from '@/server/app/detalle'
import { importarComprobanteEn } from '@/server/app/cola'
import type { Extraccion } from '@/server/ia/extraccion'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
  await cerrarPool()
})

function extraccionDePrueba(): Extraccion {
  return {
    campos: {
      cuit: { valor: '30-71042636-9', confianza: 0.99 },
      total: { valor: '484.344,26', confianza: 0.95 },
      cae: { valor: null, confianza: 0 },
    },
    renglones: [
      { codigo: '106817', descripcion: 'MICROONDAS', cantidad: '4',
        precioUnitario: '80.745,57', importe: '322.982,28' },
    ],
  }
}

describe('guardarExtraccionEn', () => {
  it('guarda los campos con valor y los deja listos para editar', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())

      const d = await obtenerDetalleEn(tx, id)
      const cuit = d.campos.find((c) => c.clave === 'cuit')!
      expect(cuit.valorIA).toBe('30-71042636-9')
      // VALOR_FINAL arranca igual que VALOR_IA para que el input ya traiga
      // el valor y el operador solo corrija lo que este mal.
      expect(cuit.valorFinal).toBe('30-71042636-9')
      expect(cuit.corregido).toBe(false)
    })
  })

  it('devuelve la confianza promedio de los campos con valor', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      // cuit 0.99 y total 0.95 tienen valor; cae es null y no promedia.
      const prom = await guardarExtraccionEn(tx, id, extraccionDePrueba())
      expect(prom).toBeCloseTo(0.97, 4)
    })
  })

  it('guarda los renglones en orden', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      const d = await obtenerDetalleEn(tx, id)
      expect(d.renglones).toHaveLength(1)
      expect(d.renglones[0].orden).toBe(1)
      expect(d.renglones[0].descripcion).toBe('MICROONDAS')
    })
  })

  it('descarta claves que no estan en el catalogo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const e = extraccionDePrueba()
      e.campos.inventado = { valor: 'x', confianza: 1 }
      await guardarExtraccionEn(tx, id, e)
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.map((c) => c.clave)).not.toContain('inventado')
    })
  })

  it('reprocesar reemplaza lo anterior en vez de duplicar', async () => {
    // PHF_CAMPO tiene UNIQUE (COMPROBANTE_ID, CLAVE): un segundo guardado
    // sin borrar el anterior violaria la constraint.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.filter((c) => c.clave === 'cuit')).toHaveLength(1)
      expect(d.renglones).toHaveLength(1)
    })
  })
})

describe('guardarCampoEn', () => {
  it('marca el campo como corregido y no toca el valor de la IA', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarExtraccionEn(tx, id, extraccionDePrueba())
      await guardarCampoEn(tx, id, 'cuit', '30-71042636-0')

      const cuit = (await obtenerDetalleEn(tx, id)).campos.find((c) => c.clave === 'cuit')!
      expect(cuit.valorFinal).toBe('30-71042636-0')
      expect(cuit.corregido).toBe(true)
      expect(cuit.valorIA).toBe('30-71042636-9')
    })
  })

  it('crea el campo si la IA no lo habia devuelto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'condcompra', '10')
      const c = (await obtenerDetalleEn(tx, id)).campos.find((x) => x.clave === 'condcompra')!
      expect(c.valorFinal).toBe('10')
      expect(c.valorIA).toBeNull()
    })
  })

  it('rechaza una clave que no esta en el catalogo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await expect(guardarCampoEn(tx, id, 'inventado', 'x')).rejects.toThrow(/clave/i)
    })
  })

  it('no escribe nada sobre un comprobante registrado: es terminal e inmutable', async () => {
    // Formulario (que no se toca) no conoce el estado del comprobante, asi
    // que el freno tiene que vivir en la escritura. El campo 'cuit' se
    // deja cargado ANTES de pasar a 'registrado' (simulando el recorrido
    // real: se completa en 'leido', se confirma, se registra), para
    // cubrir tanto el UPDATE que no debe pasar sobre un campo existente
    // como el INSERT que no debe pasar para uno que todavia no existia.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'cuit', '30-71042636-9', { corregidoPorUsuario: false })

      await tx.request().input('id', sql.Int, id)
        .query("UPDATE PHF_COMPROBANTE SET ESTADO = 'registrado' WHERE ID = @id")

      await guardarCampoEn(tx, id, 'cuit', '30-71042636-0')
      await guardarCampoEn(tx, id, 'condcompra', '10')

      const d = await obtenerDetalleEn(tx, id)
      expect(d.campos.find((c) => c.clave === 'condcompra')).toBeUndefined()
      const cuit = d.campos.find((c) => c.clave === 'cuit')!
      expect(cuit.valorFinal).toBe('30-71042636-9')
      expect(cuit.corregido).toBe(false)
    })
  })
})

describe('obtenerDetalleEn — renglones con remito', () => {
  it('expone id y el link a remito de cada renglon', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      const r = await tx.request()
        .input('cid', sql.Int, id).input('orden', sql.Int, 1)
        .query(`
          INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
          OUTPUT INSERTED.ID
          VALUES (@cid, @orden, '106817', 'Articulo', 4, 80745.57, 322982.28)`)
      const renglonId = Number(r.recordset[0].ID)

      await tx.request()
        .input('id', sql.Int, renglonId).input('n', sql.VarChar(8), '00003805').input('nr', sql.Int, 1)
        .query(`UPDATE PHF_RENGLON SET REMITO_NCOMP_IN_S=@n, REMITO_N_RENGL_S=@nr WHERE ID=@id`)

      const detalle = await obtenerDetalleEn(tx, id)
      expect(detalle.renglones).toHaveLength(1)
      expect(detalle.renglones[0].id).toBe(renglonId)
      expect(detalle.renglones[0].remitoNcompInS?.trim()).toBe('00003805')
      expect(detalle.renglones[0].remitoNRenglS).toBe(1)
    })
  })

  it('renglon sin remito asignado expone null en ambos campos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await tx.request()
        .input('cid', sql.Int, id).input('orden', sql.Int, 1)
        .query(`
          INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA)
          VALUES (@cid, @orden, '1', 'Sin remito')`)

      const detalle = await obtenerDetalleEn(tx, id)
      expect(detalle.renglones[0].remitoNcompInS).toBeNull()
      expect(detalle.renglones[0].remitoNRenglS).toBeNull()
    })
  })
})

describe('auditarEn', () => {
  it('escribe una entrada y la devuelve en el detalle', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await auditarEn(tx, id, 'PDF importado desde carga manual')
      const d = await obtenerDetalleEn(tx, id)
      expect(d.auditoria).toHaveLength(1)
      expect(d.auditoria[0].texto).toBe('PDF importado desde carga manual')
      expect(d.auditoria[0].usuario).not.toBe('')
    })
  })
})

describe('buscarComprobantePorHashEn', () => {
  it('encuentra el comprobante que tiene ese hash de archivo', async () => {
    await conRollback(async (tx) => {
      const pdf = Buffer.from(`%PDF-1.4 hash de prueba ${Date.now()}`)
      const id = await importarComprobanteEn(tx, 'factura.pdf', pdf)
      const r = await tx.request().input('id', sql.Int, id)
        .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
      creados.push(String(r.recordset[0].ARCHIVO_RUTA))

      const hash = createHash('sha256').update(pdf).digest('hex')
      expect(await buscarComprobantePorHashEn(tx, hash)).toBe(id)
    })
  })

  it('devuelve null si ningun comprobante tiene ese hash', async () => {
    await conRollback(async (tx) => {
      expect(await buscarComprobantePorHashEn(tx, '0'.repeat(64))).toBeNull()
    })
  })
})
