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

  it('busca por razon social con varias palabras, conservando el espacio', async () => {
    // "metalurgica del" solo matchea si @like conserva el espacio entre
    // palabras. Si el patron colapsara los espacios, este LIKE dejaria de
    // ser un substring valido de "METALURGICA DEL SUR SRL".
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: 'metalurgica del' })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe('METALURGICA DEL SUR SRL')
    })
  })

  it('busca por CUIT con guiones y encuentra uno guardado sin guiones', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '30-64872913-7' })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe('DISTRIBUIDORA NORTE SA')
    })
  })

  it('busca sin guiones y encuentra un CUIT guardado con guiones', async () => {
    // En el maestro de Tango los CUIT se guardan con guiones (23-23292431-4),
    // asi que la app tiene que encontrarlos aunque el operador busque sin
    // guiones. Esto solo funciona si el REPLACE tambien se aplica sobre la
    // columna CUIT, no solo sobre la query.
    await conRollback(async (tx) => {
      await sembrar(tx)
      await insertarComprobantePrueba(tx, {
        estado: 'leido',
        razonSocial: 'INSUMOS DEL LITORAL SA',
        cuit: '23-23292431-4',
        tipo: 'FAC A',
        numero: '0002-00000555',
        total: 75000,
      })
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '23232924314' })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe('INSUMOS DEL LITORAL SA')
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

  it('la segunda pagina trae el resto sin duplicar ni saltear filas', async () => {
    await conRollback(async (tx) => {
      await sembrar(tx)
      const pagina1 = await listarComprobantesEn(tx, { filtro: 'todos', query: '', limite: 2, offset: 0 })
      const pagina2 = await listarComprobantesEn(tx, { filtro: 'todos', query: '', limite: 2, offset: 2 })

      expect(pagina1.filas).toHaveLength(2)
      expect(pagina2.filas).toHaveLength(1)
      expect(pagina2.total).toBe(3)

      const idsPagina1 = pagina1.filas.map((f) => f.id)
      const idsPagina2 = pagina2.filas.map((f) => f.id)
      // sin duplicados entre paginas
      expect(idsPagina1.filter((id) => idsPagina2.includes(id))).toHaveLength(0)
      // juntas cubren las 3 filas sembradas
      expect(new Set([...idsPagina1, ...idsPagina2]).size).toBe(3)
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

  it('cuenta registrados hoy y excluye los registrados en otra fecha', async () => {
    await conRollback(async (tx) => {
      const hoy = new Date()
      const ayer = new Date()
      ayer.setDate(ayer.getDate() - 1)

      await insertarComprobantePrueba(tx, {
        estado: 'registrado',
        razonSocial: 'REGISTRADO HOY SA',
        cuit: '30111111112',
        tipo: 'FAC A',
        numero: '0001-00000001',
        total: 1000,
        fechaRegistro: hoy,
      })
      await insertarComprobantePrueba(tx, {
        estado: 'registrado',
        razonSocial: 'REGISTRADO AYER SA',
        cuit: '30222222223',
        tipo: 'FAC A',
        numero: '0001-00000002',
        total: 2000,
        fechaRegistro: ayer,
      })

      const k = await obtenerKpisEn(tx)
      expect(k.registradosHoy).toBe(1)
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
