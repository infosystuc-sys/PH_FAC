import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import {
  listarComprobantesEn,
  obtenerKpisEn,
  contarPorEstadoEn,
  insertarComprobantePrueba,
} from '@/server/app/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

async function sembrar(tx: sql.Transaction) {
  await insertarComprobantePrueba(tx, {
    estado: 'leido',
    razonSocial: 'DISTRIBUIDORA NORTE SA',
    cuit: '30648729137',
    tipo: 'FAC A',
    numero: '0003-00018742',
    total: 100000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'observacion',
    razonSocial: 'METALURGICA DEL SUR SRL',
    cuit: '30112223334',
    tipo: 'FAC A',
    numero: '0007-00000912',
    total: 50000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'registrado',
    razonSocial: 'PAPELERA CENTRO SA',
    cuit: '33556667778',
    tipo: 'FAC B',
    numero: '0001-00004411',
    total: 25000,
  })
}

describe('listarComprobantes', () => {
  it('sin filtro devuelve todo lo sembrado', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '' })
      expect(r.total).toBe(3)
    })
  })

  it('filtra por estado', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'leido', query: '' })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe('DISTRIBUIDORA NORTE SA')
    })
  })

  it('busca por razon social sin distinguir mayusculas', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: 'metalurgica' })
      expect(r.total).toBe(1)
    })
  })

  it('busca por CUIT', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '30648729137' })
      expect(r.total).toBe(1)
    })
  })

  it('busca por numero de comprobante', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '00018742' })
      expect(r.total).toBe(1)
    })
  })

  it('combina filtro y busqueda con AND', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'registrado', query: 'metalurgica' })
      expect(r.total).toBe(0)
    })
  })

  it('pagina con limite y offset', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '', limite: 2, offset: 0 })
      expect(r.filas).toHaveLength(2)
      expect(r.total).toBe(3)
    })
  })
})

describe('obtenerKpis', () => {
  it('cuenta pendientes y en observacion, y suma el importe de ambos', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const k = await obtenerKpisEn(tx)
      expect(k.pendientes).toBe(1)
      expect(k.enObservacion).toBe(1)
      expect(k.importePendiente).toBe(150000)
    })
  })
})

describe('contarPorEstado', () => {
  it('devuelve el conteo de cada tab', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const c = await contarPorEstadoEn(tx, '')
      expect(c.todos).toBe(3)
      expect(c.leido).toBe(1)
      expect(c.observacion).toBe(1)
      expect(c.registrado).toBe(1)
      expect(c.confirmado).toBe(0)
      expect(c.error).toBe(0)
    })
  })

  it('aplica la busqueda al conteo', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const c = await contarPorEstadoEn(tx, 'papelera')
      expect(c.todos).toBe(1)
      expect(c.registrado).toBe(1)
    })
  })
})
