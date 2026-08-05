import { describe, it, expect, afterAll } from 'vitest'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { insertarComprobantePrueba } from '@/server/app/comprobantes'
import { guardarExtraccionEn, obtenerDetalleEn, guardarCampoEn, auditarEn } from '@/server/app/detalle'
import type { Extraccion } from '@/server/ia/extraccion'

afterAll(async () => {
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
