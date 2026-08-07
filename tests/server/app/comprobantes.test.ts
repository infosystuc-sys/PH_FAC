import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { randomUUID } from 'node:crypto'
import { conRollback } from '@/server/db/tx'
import { cerrarPool } from '@/server/db/pool'
import { formatFecha } from '@/lib/formato'
import {
  listarComprobantesEn,
  obtenerKpisEn,
  contarPorEstadoEn,
  insertarComprobantePrueba,
  obtenerVecinosEn,
} from '@/server/app/comprobantes'

afterAll(async () => {
  await cerrarPool()
})

// PHF_COMPROBANTE no esta vacia: tiene comprobantes reales de la operacion
// y, en desarrollo, las filas de muestra de `pnpm seed`. No se puede vaciar
// ni truncar esa tabla (ni siquiera dentro de un rollback), asi que estos
// tests no pueden asumir que son las unicas filas de la tabla ni que
// arrancan de un conteo en cero.
//
// Estrategia:
//  - Para KPIs/conteos que agregan sobre toda la tabla sin filtro de texto
//    (obtenerKpisEn, contarPorEstadoEn(tx, '')), medimos una linea de base
//    ANTES de sembrar y afirmamos sobre la diferencia.
//  - Para busquedas por texto, le damos a cada fila sembrada una "marca"
//    unica por corrida (8 hex de un UUID) y construimos la query alrededor
//    de esa marca. Ninguna fila ambiental (real o de seed) puede contener
//    esa marca, asi que el total da un numero exacto sin depender de la
//    linea de base.

/** Marca unica por insercion: aisla la fila de cualquier dato preexistente. */
function marcaUnica(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8)
}

/** CUIT de 11 digitos al azar. La chance de colision con uno ya cargado es despreciable. */
function cuitUnico(): string {
  const resto = Math.floor(100000000 + Math.random() * 900000000)
  return `30${resto}`
}

function conGuiones(cuit: string): string {
  return `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}`
}

type FilaSembrada = { marca: string; razonSocial: string; cuit: string; numero: string }

function filaSembrada(nombre: string, puntoVenta: string): FilaSembrada {
  const marca = marcaUnica()
  return {
    marca,
    razonSocial: `${marca} ${nombre}`,
    cuit: cuitUnico(),
    numero: `${puntoVenta}-${marca}`,
  }
}

/**
 * Siembra 3 comprobantes (uno por estado clave), cada uno con su propia
 * marca/CUIT/numero unicos por corrida.
 */
async function sembrar(tx: sql.Transaction) {
  const leido = filaSembrada('DISTRIBUIDORA NORTE SA', '0003')
  const observacion = filaSembrada('METALURGICA DEL SUR SRL', '0007')
  const registrado = filaSembrada('PAPELERA CENTRO SA', '0001')

  await insertarComprobantePrueba(tx, {
    estado: 'leido',
    razonSocial: leido.razonSocial,
    cuit: leido.cuit,
    tipo: 'FAC A',
    numero: leido.numero,
    total: 100000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'observacion',
    razonSocial: observacion.razonSocial,
    cuit: observacion.cuit,
    tipo: 'FAC A',
    numero: observacion.numero,
    total: 50000,
  })
  await insertarComprobantePrueba(tx, {
    estado: 'registrado',
    razonSocial: registrado.razonSocial,
    cuit: registrado.cuit,
    tipo: 'FAC B',
    numero: registrado.numero,
    total: 25000,
  })

  return { leido, observacion, registrado }
}

/**
 * Igual que sembrar, pero las 3 filas comparten una unica marca. Sirve para
 * probar paginacion: filtrando por esa marca el total da exactamente 3, sin
 * importar cuantas filas ambientales haya en la tabla.
 */
async function sembrarGrupo(tx: sql.Transaction): Promise<string> {
  const marca = marcaUnica()
  const filas = [
    {
      estado: 'leido' as const,
      razonSocial: `${marca} DISTRIBUIDORA NORTE SA`,
      cuit: cuitUnico(),
      tipo: 'FAC A',
      numero: `0003-${marca}`,
      total: 100000,
    },
    {
      estado: 'observacion' as const,
      razonSocial: `${marca} METALURGICA DEL SUR SRL`,
      cuit: cuitUnico(),
      tipo: 'FAC A',
      numero: `0007-${marca}`,
      total: 50000,
    },
    {
      estado: 'registrado' as const,
      razonSocial: `${marca} PAPELERA CENTRO SA`,
      cuit: cuitUnico(),
      tipo: 'FAC B',
      numero: `0001-${marca}`,
      total: 25000,
    },
  ]
  for (const f of filas) await insertarComprobantePrueba(tx, f)
  return marca
}

describe('listarComprobantes', () => {
  it('sin filtro devuelve todo lo sembrado', async () => {
    await conRollback(async (tx) => {
      const antes = await listarComprobantesEn(tx, { filtro: 'todos', query: '' })
      await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: '' })
      expect(r.total).toBe(antes.total + 3)
    })
  })

  it('filtra por estado', async () => {
    await conRollback(async (tx) => {
      const antes = await listarComprobantesEn(tx, { filtro: 'leido', query: '' })
      const { leido } = await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'leido', query: '' })
      expect(r.total).toBe(antes.total + 1)
      // La fila recien insertada tiene el ID mas alto de toda la tabla, asi
      // que ordenada por FECHA_ALTA/ID DESC siempre queda primera.
      expect(r.filas[0].razonSocial).toBe(leido.razonSocial)
    })
  })

  it('busca por razon social sin distinguir mayusculas', async () => {
    await conRollback(async (tx) => {
      const { observacion } = await sembrar(tx)
      // mayuscula en el dato guardado, minuscula en la busqueda.
      const query = `${observacion.marca} metalurgica`
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(observacion.razonSocial)
    })
  })

  it('busca por CUIT', async () => {
    await conRollback(async (tx) => {
      const { leido } = await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: leido.cuit })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(leido.razonSocial)
    })
  })

  it('busca por razon social con varias palabras, conservando el espacio', async () => {
    // "<marca> metalurgica del" solo matchea si @like conserva el espacio
    // entre palabras. Si el patron colapsara los espacios, este LIKE
    // dejaria de ser un substring valido de la razon social guardada.
    await conRollback(async (tx) => {
      const { observacion } = await sembrar(tx)
      const query = `${observacion.marca} metalurgica del`
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(observacion.razonSocial)
    })
  })

  it('busca por CUIT con guiones y encuentra uno guardado sin guiones', async () => {
    await conRollback(async (tx) => {
      const { leido } = await sembrar(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: conGuiones(leido.cuit) })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(leido.razonSocial)
    })
  })

  it('busca sin guiones y encuentra un CUIT guardado con guiones', async () => {
    // En el maestro de Tango los CUIT se guardan con guiones (23-23292431-4),
    // asi que la app tiene que encontrarlos aunque el operador busque sin
    // guiones. Esto solo funciona si el REPLACE tambien se aplica sobre la
    // columna CUIT, no solo sobre la query.
    await conRollback(async (tx) => {
      const digitos = cuitUnico()
      const marca = marcaUnica()
      const razonSocial = `${marca} INSUMOS DEL LITORAL SA`
      await insertarComprobantePrueba(tx, {
        estado: 'leido',
        razonSocial,
        cuit: conGuiones(digitos),
        tipo: 'FAC A',
        numero: `0002-${marca}`,
        total: 75000,
      })
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: digitos })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(razonSocial)
    })
  })

  it('busca por numero de comprobante', async () => {
    await conRollback(async (tx) => {
      const { leido } = await sembrar(tx)
      // Se busca el numero completo (no solo la marca) para que el match
      // venga realmente de la columna NUMERO y no de RAZON_SOCIAL, que
      // tambien contiene la marca.
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: leido.numero })
      expect(r.total).toBe(1)
      expect(r.filas[0].razonSocial).toBe(leido.razonSocial)
    })
  })

  it('combina filtro y busqueda con AND', async () => {
    await conRollback(async (tx) => {
      const { observacion } = await sembrar(tx)
      // observacion.razonSocial esta en estado 'observacion', no 'registrado':
      // combinado con el filtro no puede haber match, sea cual sea el
      // contenido preexistente de la tabla.
      const r = await listarComprobantesEn(tx, {
        filtro: 'registrado',
        query: `${observacion.marca} metalurgica`,
      })
      expect(r.total).toBe(0)
    })
  })

  it('pagina con limite y offset', async () => {
    await conRollback(async (tx) => {
      const marca = await sembrarGrupo(tx)
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: marca, limite: 2, offset: 0 })
      expect(r.filas).toHaveLength(2)
      expect(r.total).toBe(3)
    })
  })

  it('ida y vuelta de FECHA_EMISION conserva el dia en hora local', async () => {
    // Guarda contra useUTC:true en la config del pool (ver src/server/db/pool.ts):
    // con useUTC:true, una columna DATE guardada como 2026-05-18 volveria como
    // 2026-05-18T00:00:00Z, y formatFecha (que usa getDate()/getMonth() locales)
    // mostraria 17/05/2026 en Argentina (UTC-3). Este test lee una fecha
    // conocida de ida y vuelta por la base real y verifica que el dia no se mueve.
    await conRollback(async (tx) => {
      const marca = marcaUnica()
      const fechaEmision = new Date(2026, 4, 18) // 18/05/2026, medianoche local
      await insertarComprobantePrueba(tx, {
        estado: 'leido',
        razonSocial: `${marca} FECHA CONOCIDA SA`,
        cuit: cuitUnico(),
        tipo: 'FAC A',
        numero: `0009-${marca}`,
        total: 1000,
        fechaEmision,
      })
      const r = await listarComprobantesEn(tx, { filtro: 'todos', query: marca })
      expect(r.total).toBe(1)
      expect(formatFecha(r.filas[0].fechaEmision)).toBe('18/05/2026')
    })
  })

  it('la segunda pagina trae el resto sin duplicar ni saltear filas', async () => {
    await conRollback(async (tx) => {
      const marca = await sembrarGrupo(tx)
      const pagina1 = await listarComprobantesEn(tx, { filtro: 'todos', query: marca, limite: 2, offset: 0 })
      const pagina2 = await listarComprobantesEn(tx, { filtro: 'todos', query: marca, limite: 2, offset: 2 })

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
      const antes = await obtenerKpisEn(tx)
      await sembrar(tx)
      const k = await obtenerKpisEn(tx)
      expect(k.pendientes).toBe(antes.pendientes + 1)
      expect(k.enObservacion).toBe(antes.enObservacion + 1)
      expect(k.importePendiente).toBe(antes.importePendiente + 150000)
    })
  })

  it('cuenta registrados hoy y excluye los registrados en otra fecha', async () => {
    await conRollback(async (tx) => {
      const antes = await obtenerKpisEn(tx)
      const hoy = new Date()
      const ayer = new Date()
      ayer.setDate(ayer.getDate() - 1)
      const marca = marcaUnica()

      await insertarComprobantePrueba(tx, {
        estado: 'registrado',
        razonSocial: `${marca} REGISTRADO HOY SA`,
        cuit: cuitUnico(),
        tipo: 'FAC A',
        numero: `0001-${marca}`,
        total: 1000,
        fechaRegistro: hoy,
      })
      await insertarComprobantePrueba(tx, {
        estado: 'registrado',
        razonSocial: `${marca} REGISTRADO AYER SA`,
        cuit: cuitUnico(),
        tipo: 'FAC A',
        numero: `0002-${marca}`,
        total: 2000,
        fechaRegistro: ayer,
      })

      const k = await obtenerKpisEn(tx)
      expect(k.registradosHoy).toBe(antes.registradosHoy + 1)
    })
  })
})

describe('contarPorEstado', () => {
  it('devuelve el conteo de cada tab', async () => {
    await conRollback(async (tx) => {
      const antes = await contarPorEstadoEn(tx, '')
      await sembrar(tx)
      const c = await contarPorEstadoEn(tx, '')
      expect(c.todos).toBe(antes.todos + 3)
      expect(c.leido).toBe(antes.leido + 1)
      expect(c.observacion).toBe(antes.observacion + 1)
      expect(c.registrado).toBe(antes.registrado + 1)
      expect(c.confirmado).toBe(antes.confirmado)
      expect(c.error).toBe(antes.error)
    })
  })

  it('aplica la busqueda al conteo', async () => {
    await conRollback(async (tx) => {
      const { registrado } = await sembrar(tx)
      const c = await contarPorEstadoEn(tx, `${registrado.marca} papelera`)
      expect(c.todos).toBe(1)
      expect(c.registrado).toBe(1)
    })
  })
})

describe('obtenerVecinosEn', () => {
  // Igual que el resto del archivo: PHF_COMPROBANTE tiene comprobantes
  // reales en estado 'leido' (pendientes de revision de la operacion), asi
  // que "a es el mas viejo de los tres" no vale sin acotar la busqueda -
  // siempre puede haber un 'leido' ambiental mas viejo todavia. Se aisla
  // con la misma marca unica que usan los demas tests, pasada como `query`
  // (obtenerVecinosEn filtra tambien por busqueda, igual que listarComprobantesEn).
  it('encuentra el anterior y el siguiente dentro del mismo filtro', async () => {
    await conRollback(async (tx) => {
      const marca = marcaUnica()
      const a = await insertarComprobantePrueba(tx, { estado: 'leido', razonSocial: `${marca} A` })
      const b = await insertarComprobantePrueba(tx, { estado: 'leido', razonSocial: `${marca} B` })
      const c = await insertarComprobantePrueba(tx, { estado: 'leido', razonSocial: `${marca} C` })
      // Orden de la bandeja: FECHA_ALTA DESC, ID DESC -> mas nuevo primero: c, b, a.

      const vecinosDeB = await obtenerVecinosEn(tx, { filtro: 'leido', query: marca }, b)
      expect(vecinosDeB.anteriorId).toBe(c) // mas nuevo que b
      expect(vecinosDeB.siguienteId).toBe(a) // mas viejo que b

      const vecinosDeC = await obtenerVecinosEn(tx, { filtro: 'leido', query: marca }, c)
      expect(vecinosDeC.anteriorId).toBe(null) // c es el mas nuevo de los tres

      const vecinosDeA = await obtenerVecinosEn(tx, { filtro: 'leido', query: marca }, a)
      expect(vecinosDeA.siguienteId).toBe(null) // a es el mas viejo de los tres
    })
  })

  it('no cruza el filtro activo', async () => {
    await conRollback(async (tx) => {
      const marca = marcaUnica()
      const a = await insertarComprobantePrueba(tx, { estado: 'leido', razonSocial: `${marca} A` })
      // no deberia contar como vecino
      await insertarComprobantePrueba(tx, { estado: 'confirmado', razonSocial: `${marca} MEDIO` })
      const c = await insertarComprobantePrueba(tx, { estado: 'leido', razonSocial: `${marca} C` })

      const vecinosDeC = await obtenerVecinosEn(tx, { filtro: 'leido', query: marca }, c)
      expect(vecinosDeC.siguienteId).toBe(a) // salta el 'confirmado' del medio
    })
  })
})
