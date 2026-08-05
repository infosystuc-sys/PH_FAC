import { describe, it, expect, afterAll } from 'vitest'
import { migrar, migrarDefiniciones } from '../../scripts/migrate'
import { getPool, cerrarPool } from '@/server/db/pool'

const TABLAS = ['PHF_COMPROBANTE', 'PHF_CAMPO', 'PHF_RENGLON', 'PHF_AUDITORIA']

describe('migracion del esquema propio', () => {
  afterAll(async () => {
    await cerrarPool()
  })

  it('crea las cuatro tablas PHF_', async () => {
    await migrar()
    const pool = await getPool()
    const r = await pool
      .request()
      .query("SELECT name FROM sys.tables WHERE name LIKE 'PHF[_]%' ORDER BY name")
    const nombres = r.recordset.map((x) => x.name)
    for (const t of TABLAS) expect(nombres).toContain(t)
  })

  it('es idempotente: la segunda corrida no crea nada', async () => {
    await migrar()
    const creadas = await migrar()
    expect(creadas).toEqual([])
  })

  it('no crea tablas fuera del prefijo PHF_', async () => {
    const pool = await getPool()
    const antes = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    await migrar()
    const despues = await pool.request().query('SELECT COUNT(*) AS n FROM sys.tables')
    expect(despues.recordset[0].n).toBe(antes.recordset[0].n)
  })

  it('rechaza un estado invalido', async () => {
    const pool = await getPool()
    await expect(
      pool.request().query(`
        INSERT INTO PHF_COMPROBANTE (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, USUARIO_ALTA)
        VALUES ('x.pdf', 'x', REPLICATE('0', 64), 'inventado', 'test')
      `),
    ).rejects.toThrow()
  })
})

// Las 4 tablas PHF_ arriba ya existen permanentemente en la base, asi que
// migrar() sobre ellas es un no-op y los tests de arriba no pueden probar
// que el CREATE se ejecuta de verdad ni que un DDL roto se revierte. Estos
// tests corren la migracion real con un prefijo de tabla unico por corrida
// (siempre arrancando con "PHF_", por la restriccion del proyecto) para
// ejercitar el CREATE de verdad contra la base, y limpian todo lo que crean.
describe('migracion: ejercitando el CREATE de verdad', () => {
  const prefijosUsados: string[] = []

  afterAll(async () => {
    const pool = await getPool()
    // Los hijos (FK con ON DELETE CASCADE) tienen que caer antes que
    // PHF_COMPROBANTE, que es la tabla referenciada.
    const sufijosEnOrden = ['CAMPO', 'RENGLON', 'AUDITORIA', 'COMPROBANTE', 'ROTA']
    for (const prefijo of prefijosUsados) {
      for (const sufijo of sufijosEnOrden) {
        const tabla = `${prefijo}${sufijo}`
        await pool
          .request()
          .batch(`IF OBJECT_ID('dbo.${tabla}') IS NOT NULL DROP TABLE ${tabla}`)
      }
    }

    // Red de seguridad: confirmar que no quedo nada huerfano con ninguno de
    // los prefijos de prueba usados en esta corrida.
    for (const prefijo of prefijosUsados) {
      const r = await pool
        .request()
        .input('patron', `${prefijo}%`)
        .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name LIKE @patron')
      expect(r.recordset[0].n).toBe(0)
    }

    await cerrarPool()
  })

  function prefijoUnico(): string {
    const p = `PHF_test${Date.now()}_${Math.floor(Math.random() * 1e6)}_`
    prefijosUsados.push(p)
    return p
  }

  it('crea las tablas de verdad, con sus indices, bajo un prefijo de prueba', async () => {
    const prefijo = prefijoUnico()
    const creadas = await migrar(prefijo)

    expect(creadas.sort()).toEqual(TABLAS.map((t) => t.replace('PHF_', prefijo)).sort())

    const pool = await getPool()
    const tablaComp = `${prefijo}COMPROBANTE`
    const r = await pool
      .request()
      .input('t', tablaComp)
      .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @t')
    expect(r.recordset[0].n).toBe(1)

    const idx = await pool
      .request()
      .input('t', tablaComp)
      .query(`
        SELECT COUNT(*) AS n FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        WHERE t.name = @t AND i.name LIKE 'IX[_]%'
      `)
    expect(idx.recordset[0].n).toBe(3)
  })

  it('la segunda corrida con el mismo prefijo no crea nada', async () => {
    const prefijo = prefijoUnico()
    await migrar(prefijo)
    const creadas = await migrar(prefijo)
    expect(creadas).toEqual([])
  })

  it('un DDL roto revierte tambien el CREATE TABLE (atomicidad)', async () => {
    const prefijo = prefijoUnico()
    const definicionRota = [
      {
        tabla: 'PHF_ROTA',
        ddl: `
          CREATE TABLE PHF_ROTA (
            ID INT IDENTITY(1,1) NOT NULL,
            A  INT NOT NULL,
            CONSTRAINT PK_PHF_ROTA PRIMARY KEY (ID)
          );
          CREATE INDEX IX_PHF_ROTA_MAL ON PHF_ROTA (COLUMNA_QUE_NO_EXISTE);
        `,
      },
    ]

    await expect(migrarDefiniciones(definicionRota, prefijo)).rejects.toThrow()

    // Si el CREATE TABLE no se hubiera revertido junto con el CREATE INDEX
    // fallido, esta tabla existiria a pesar del error -- y el chequeo de
    // idempotencia la saltearia para siempre en corridas futuras.
    const pool = await getPool()
    const r = await pool
      .request()
      .input('t', `${prefijo}ROTA`)
      .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @t')
    expect(r.recordset[0].n).toBe(0)
  })
})
