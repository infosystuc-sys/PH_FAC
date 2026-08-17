import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { migrar, migrarDefiniciones } from '../../scripts/migrate'
import { getPool, cerrarPool } from '@/server/db/pool'

const TABLAS = ['PHF_COMPROBANTE', 'PHF_CAMPO', 'PHF_RENGLON', 'PHF_AUDITORIA']

async function columnas(pool: sql.ConnectionPool, tabla: string): Promise<string[]> {
  const r = await pool
    .request()
    .input('t', tabla)
    .query(`
      SELECT c.name AS nombre
      FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
      WHERE t.name = @t ORDER BY c.name
    `)
  return r.recordset.map((x: { nombre: string }) => x.nombre)
}

async function limpiarPrefijo(pool: sql.ConnectionPool, prefijo: string): Promise<void> {
  // Orden inverso al de creacion por las FK.
  for (const t of ['AUDITORIA', 'RENGLON', 'CAMPO', 'COMPROBANTE']) {
    await pool.request().batch(`DROP TABLE IF EXISTS ${prefijo}${t}`)
  }
}

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

  // Timeout propio: es el que borra lo que crearon los tests, y con los 10s
  // por defecto se cortaba dejando tablas atras.
  afterAll(async () => {
    try {
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

      // Red de seguridad: confirmar que no quedo nada huerfano con ninguno
      // de los prefijos de prueba usados en esta corrida.
      for (const prefijo of prefijosUsados) {
        const r = await pool
          .request()
          .input('patron', `${prefijo}%`)
          .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name LIKE @patron')
        expect(r.recordset[0].n).toBe(0)
      }
    } finally {
      // Si la asercion de arriba falla, el pool tiene que cerrarse igual --
      // si no, vitest puede colgarse en vez de reportar el fallo limpio.
      await cerrarPool()
    }
  }, 120_000)

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
        ddlTabla: `
          CREATE TABLE PHF_ROTA (
            ID INT IDENTITY(1,1) NOT NULL,
            A  INT NOT NULL,
            CONSTRAINT PK_PHF_ROTA PRIMARY KEY (ID)
          );
        `,
        indices: [
          { nombre: 'IX_PHF_ROTA_MAL', ddl: 'CREATE INDEX IX_PHF_ROTA_MAL ON PHF_ROTA (COLUMNA_QUE_NO_EXISTE);' },
        ],
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

  it('repara una tabla existente a la que le falta un indice, sin tocar el CREATE TABLE', async () => {
    const prefijo = prefijoUnico()
    await migrar(prefijo)

    const pool = await getPool()
    const tablaComp = `${prefijo}COMPROBANTE`
    const indiceCaido = 'IX_PHF_COMP_ESTADO'.replace('PHF_', prefijo)

    // Simula el escenario del bug: la tabla existe pero le falta un indice
    // (esquema restaurado de una version vieja, o alguien dropeo el indice
    // a mano).
    await pool.request().batch(`DROP INDEX ${indiceCaido} ON ${tablaComp}`)

    const antesDeReparar = await pool
      .request()
      .input('t', indiceCaido)
      .query('SELECT COUNT(*) AS n FROM sys.indexes WHERE name = @t')
    expect(antesDeReparar.recordset[0].n).toBe(0)

    // Antes del fix, este migrar() volvia a intentar el CREATE TABLE
    // completo contra una tabla que ya existe y fallaba duro (error 2714).
    await expect(migrar(prefijo)).resolves.not.toThrow()

    const idx = await pool
      .request()
      .input('t', indiceCaido)
      .query('SELECT COUNT(*) AS n FROM sys.indexes WHERE name = @t')
    expect(idx.recordset[0].n).toBe(1)

    // Correr de nuevo no debe fallar ni volver a intentar nada: el indice
    // ya esta reparado.
    const segunda = await migrar(prefijo)
    expect(segunda).toEqual([])
  })

  it('agrega una columna que falta sin tocar el resto de la tabla', async () => {
    const prefijo = prefijoUnico()
    const pool = await getPool()
    const tabla = `${prefijo}COMPROBANTE`

    try {
      // Se crea la tabla completa y despues se le saca una columna, para
      // simular una base que quedo en la version anterior del esquema.
      await migrar(prefijo)
      await pool.request().batch(`ALTER TABLE ${tabla} DROP COLUMN EXTRACCION_MS`)

      const antes = await columnas(pool, tabla)
      expect(antes).not.toContain('EXTRACCION_MS')

      await migrar(prefijo)

      const despues = await columnas(pool, tabla)
      expect(despues).toContain('EXTRACCION_MS')
      // No se perdio nada mas en el camino.
      expect(despues.length).toBe(antes.length + 1)
    } finally {
      await limpiarPrefijo(pool, prefijo)
    }
  })

  it('la tabla creada de cero y la reparada tienen las mismas columnas', async () => {
    // Las columnas nuevas estan declaradas dos veces -- en el CREATE TABLE y
    // en `columnas`, para el camino de reparacion. Este test es lo que evita
    // que esas dos declaraciones se separen.
    const pool = await getPool()
    const pA = prefijoUnico()
    const pB = prefijoUnico()

    try {
      await migrar(pA)
      await migrar(pB)
      // INTENTOS tiene un DEFAULT con nombre propio: SQL Server no deja
      // sacar la columna sin sacar antes la constraint. Se busca el nombre
      // en vez de asumirlo, porque `conPrefijo` lo reescribe con el
      // prefijo de prueba (DF_PHF_COMP_INTENTOS -> DF_${pB}COMP_INTENTOS).
      await pool.request().batch(`
        DECLARE @constraint sysname
        SELECT @constraint = dc.name
        FROM sys.default_constraints dc
        JOIN sys.columns c ON c.default_object_id = dc.object_id
        WHERE dc.parent_object_id = OBJECT_ID('${pB}COMPROBANTE') AND c.name = 'INTENTOS'
        EXEC('ALTER TABLE ${pB}COMPROBANTE DROP CONSTRAINT ' + @constraint)
        ALTER TABLE ${pB}COMPROBANTE DROP COLUMN INTENTOS
      `)
      await migrar(pB)

      expect(await columnas(pool, `${pB}COMPROBANTE`)).toEqual(
        await columnas(pool, `${pA}COMPROBANTE`),
      )
    } finally {
      await limpiarPrefijo(pool, pA)
      await limpiarPrefijo(pool, pB)
    }
    // Tres migraciones completas mas DDL sobre una base de 3.100 tablas. Con
    // el timeout de 20s del proyecto se cortaba a mitad de camino, y como el
    // corte se lleva tambien el `finally` y el afterAll, cada corrida fallida
    // dejaba tablas PHF_test* sin borrar en la base.
  }, 180_000)
})
