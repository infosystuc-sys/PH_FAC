import { config as cargarEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'

cargarEnv({ path: '.env.local' })

type IndiceDef = { nombre: string; ddl: string }
type ColumnaDef = { nombre: string; ddl: string }
// `ddlTabla` es solo el CREATE TABLE (sin los indices), para que el camino
// de reparacion -- tabla existente a la que le falta un indice -- pueda
// emitir unicamente los CREATE INDEX que faltan sin volver a tocar la
// tabla. `indices` trae, por indice, su nombre (para el chequeo de
// idempotencia) y su propio DDL (para poder emitirlo suelto).
type Definicion = {
  tabla: string
  ddlTabla: string
  indices?: IndiceDef[]
  /**
   * Las columnas agregadas despues de la version inicial del esquema.
   * Estan tambien en `ddlTabla`, para que una base nueva se cree completa
   * de una; esta lista es solo el camino de reparacion de una base que
   * quedo en la version anterior. Hay un test que verifica que las dos
   * declaraciones no se separen.
   */
  columnas?: ColumnaDef[]
}

const DEFINICIONES: Definicion[] = [
  {
    tabla: 'PHF_COMPROBANTE',
    ddlTabla: `
      CREATE TABLE PHF_COMPROBANTE (
        ID                  INT IDENTITY(1,1) NOT NULL,
        ARCHIVO_NOMBRE      NVARCHAR(260)  NOT NULL,
        ARCHIVO_RUTA        NVARCHAR(500)  NOT NULL,
        ARCHIVO_HASH        CHAR(64)       NOT NULL,
        ESTADO              VARCHAR(20)    NOT NULL,
        TIPO_FACTURA        VARCHAR(20)    NULL,
        MOTIVO_OBSERVACION  NVARCHAR(60)   NULL,
        NOTA_OBSERVACION    NVARCHAR(1000) NULL,
        TIPO                VARCHAR(10)    NULL,
        PUNTO_VENTA         VARCHAR(10)    NULL,
        NUMERO              VARCHAR(20)    NULL,
        FECHA_EMISION       DATE           NULL,
        RAZON_SOCIAL        NVARCHAR(200)  NULL,
        CUIT                VARCHAR(15)    NULL,
        TOTAL               DECIMAL(19,4)  NULL,
        CONFIANZA_PROMEDIO  DECIMAL(5,4)   NULL,
        COD_PROVEE          VARCHAR(20)    NULL,
        TANGO_NCOMP_IN_C    FLOAT          NULL,
        TANGO_T_COMP        VARCHAR(10)    NULL,
        TANGO_N_COMP        VARCHAR(20)    NULL,
        FECHA_REGISTRO      DATETIME2      NULL,
        INTENTOS            INT            NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0,
        ERROR_MENSAJE       NVARCHAR(1000) NULL,
        EXTRACCION_MS       INT            NULL,
        EXTRACCION_MODELO   VARCHAR(40)    NULL,
        FECHA_ALTA          DATETIME2      NOT NULL CONSTRAINT DF_PHF_COMP_ALTA DEFAULT SYSDATETIME(),
        USUARIO_ALTA        NVARCHAR(60)   NOT NULL,
        FECHA_MODIF         DATETIME2      NULL,
        USUARIO_MODIF       NVARCHAR(60)   NULL,
        CONSTRAINT PK_PHF_COMPROBANTE PRIMARY KEY (ID),
        CONSTRAINT CK_PHF_COMP_ESTADO CHECK (ESTADO IN
          ('procesando','leido','observacion','confirmado','registrado','error'))
      );
    `,
    indices: [
      { nombre: 'IX_PHF_COMP_ESTADO', ddl: 'CREATE INDEX IX_PHF_COMP_ESTADO ON PHF_COMPROBANTE (ESTADO);' },
      {
        nombre: 'IX_PHF_COMP_DUP',
        ddl: 'CREATE INDEX IX_PHF_COMP_DUP ON PHF_COMPROBANTE (COD_PROVEE, TIPO, NUMERO);',
      },
      { nombre: 'IX_PHF_COMP_CUIT', ddl: 'CREATE INDEX IX_PHF_COMP_CUIT ON PHF_COMPROBANTE (CUIT);' },
    ],
    columnas: [
      { nombre: 'INTENTOS', ddl: 'INTENTOS INT NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0' },
      { nombre: 'ERROR_MENSAJE', ddl: 'ERROR_MENSAJE NVARCHAR(1000) NULL' },
      { nombre: 'EXTRACCION_MS', ddl: 'EXTRACCION_MS INT NULL' },
      { nombre: 'EXTRACCION_MODELO', ddl: 'EXTRACCION_MODELO VARCHAR(40) NULL' },
      // El tipo que el operador elige al importar. Vive en la cabecera y no
      // en PHF_CAMPO porque la cola lo necesita ANTES de extraer, para
      // elegir el prompt -- y porque guardarExtraccionEn borra los campos
      // del comprobante antes de reescribirlos, asi que un PHF_CAMPO
      // escrito en la importacion no sobreviviria a su propia extraccion.
      { nombre: 'TIPO_FACTURA', ddl: 'TIPO_FACTURA VARCHAR(20) NULL' },
    ],
  },
  {
    tabla: 'PHF_CAMPO',
    ddlTabla: `
      CREATE TABLE PHF_CAMPO (
        ID                     INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID         INT            NOT NULL,
        CLAVE                  VARCHAR(40)    NOT NULL,
        VALOR_IA               NVARCHAR(500)  NULL,
        CONFIANZA              DECIMAL(5,4)   NULL,
        VALOR_FINAL            NVARCHAR(500)  NULL,
        CORREGIDO_POR_USUARIO  BIT            NOT NULL CONSTRAINT DF_PHF_CAMPO_CORR DEFAULT 0,
        CONSTRAINT PK_PHF_CAMPO PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_CAMPO UNIQUE (COMPROBANTE_ID, CLAVE),
        CONSTRAINT FK_PHF_CAMPO_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    tabla: 'PHF_RENGLON',
    ddlTabla: `
      CREATE TABLE PHF_RENGLON (
        ID                  INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID      INT            NOT NULL,
        ORDEN               INT            NOT NULL,
        CODIGO_IA           NVARCHAR(60)   NULL,
        DESCRIPCION_IA      NVARCHAR(500)  NULL,
        CANTIDAD_IA         DECIMAL(19,4)  NULL,
        PRECIO_UNITARIO_IA  DECIMAL(19,4)  NULL,
        IMPORTE_IA          DECIMAL(19,4)  NULL,
        REMITO_NCOMP_IN_S   VARCHAR(20)    NULL,
        REMITO_N_RENGL_S    INT            NULL,
        REMITO_NUMERO       VARCHAR(20)    NULL,
        CANTIDAD_REMITO     DECIMAL(19,4)  NULL,
        CODIGO_FINAL        NVARCHAR(60)   NULL,
        PORC_BONIF          DECIMAL(9,4)   NULL,
        COD_PROVEEDOR       NVARCHAR(60)   NULL,
        CONSTRAINT PK_PHF_RENGLON PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_RENGLON UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_RENGLON_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
    columnas: [
      // El número impreso del remito (`N_COMP`, ej. "R0502600531798"), para
      // mostrarlo junto al renglón sin depender de que el remito siga
      // apareciendo en `buscarRemitosPendientes` -- una vez que se consume
      // del todo, desaparece de esa lista, y este dato quedaría huérfano si
      // no se guardara acá. `REMITO_NCOMP_IN_S` (el código interno) sigue
      // siendo la clave real para el join contra STA14/STA20 al registrar.
      { nombre: 'REMITO_NUMERO', ddl: 'REMITO_NUMERO VARCHAR(20) NULL' },
      // Lo que el remito entrego de ESE renglon, para poder mostrarlo al
      // lado de lo que factura el proveedor. Se guarda en vez de releerlo
      // en pantalla por el mismo motivo que REMITO_NUMERO: un remito que se
      // consume del todo desaparece de la lista de pendientes, y despues de
      // registrar el dato quedaria huerfano.
      { nombre: 'CANTIDAD_REMITO', ddl: 'CANTIDAD_REMITO DECIMAL(19,4) NULL' },
      // El articulo que el operador eligio a mano cuando el emparejamiento
      // automatico se equivoco. Mismo criterio que VALOR_IA/VALOR_FINAL en
      // PHF_CAMPO: CODIGO_IA guarda lo que resolvio el sistema y no se
      // pisa, para no contaminar la medicion de que tan bien empareja.
      { nombre: 'CODIGO_FINAL', ddl: 'CODIGO_FINAL NVARCHAR(60) NULL' },
      // El % de bonificacion de la linea. El precio unitario que imprime la
      // factura es el de lista, ANTES del descuento, y el importe ya viene
      // descontado: sin esto la suma de los renglones no cierra contra el
      // neto gravado. Va a CPA46.PORCE_DCTO al registrar.
      { nombre: 'PORC_BONIF', ddl: 'PORC_BONIF DECIMAL(9,4) NULL' },
      // El codigo con el que el proveedor identifica el articulo en SU
      // factura. Se guarda para poder asociarlo despues a nuestro articulo
      // en CPA15.COD_SINONI, que es la funcion que Tango tiene prevista.
      { nombre: 'COD_PROVEEDOR', ddl: 'COD_PROVEEDOR NVARCHAR(60) NULL' },
    ],
  },
  {
    tabla: 'PHF_AUDITORIA',
    ddlTabla: `
      CREATE TABLE PHF_AUDITORIA (
        ID              INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID  INT            NOT NULL,
        FECHA           DATETIME2      NOT NULL CONSTRAINT DF_PHF_AUD_FECHA DEFAULT SYSDATETIME(),
        TEXTO           NVARCHAR(500)  NOT NULL,
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_AUDITORIA PRIMARY KEY (ID),
        CONSTRAINT FK_PHF_AUD_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
    indices: [{ nombre: 'IX_PHF_AUD_COMP', ddl: 'CREATE INDEX IX_PHF_AUD_COMP ON PHF_AUDITORIA (COMPROBANTE_ID, FECHA);' }],
  },
]

/**
 * Todos los nombres de tabla, constraint e indice de las DEFINICIONES
 * contienen la substring "PHF_" (tabla, PK, FK, DF, CK, IX...), asi que un
 * reemplazo global de esa substring alcanza para renombrar todo de forma
 * consistente -- incluidas las referencias FK entre tablas propias -- sin
 * que un prefijo de prueba distinto choque nunca con un nombre real de la
 * base productiva.
 */
function conPrefijo(texto: string, prefijo: string): string {
  return texto.replaceAll('PHF_', prefijo)
}

async function existeTabla(pool: sql.ConnectionPool, tabla: string): Promise<boolean> {
  const r = await pool
    .request()
    .input('t', tabla)
    .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @t')
  return r.recordset[0].n > 0
}

/** Nombres, de entre `indicesEsperados`, que no existen todavia en `tabla`. */
async function indicesFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  indicesEsperados: string[],
): Promise<string[]> {
  if (indicesEsperados.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = indicesEsperados.map((nombre, i) => {
    req.input(`i${i}`, nombre)
    return `@i${i}`
  })
  const r = await req.query(`
    SELECT i.name AS nombre
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    WHERE t.name = @t AND i.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return indicesEsperados.filter((n) => !presentes.has(n))
}

/** Nombres, de entre `columnasEsperadas`, que no existen todavia en `tabla`. */
async function columnasFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  columnasEsperadas: string[],
): Promise<string[]> {
  if (columnasEsperadas.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = columnasEsperadas.map((nombre, i) => {
    req.input(`c${i}`, nombre)
    return `@c${i}`
  })
  const r = await req.query(`
    SELECT c.name AS nombre
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = @t AND c.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return columnasEsperadas.filter((n) => !presentes.has(n))
}

/**
 * Crea las tablas que falten y repara, en las que ya existen, las columnas
 * y los indices que falten. Para una tabla ausente, CREATE TABLE + todos
 * sus CREATE INDEX corren en una sola transaccion: si el CREATE TABLE pasa
 * pero un CREATE INDEX del mismo batch falla, el rollback se lleva puesta
 * tambien la tabla, para que la proxima corrida la vuelva a intentar
 * completa en vez de saltearla para siempre por el chequeo de idempotencia.
 * Para una tabla que ya existe pero le faltan columnas y/o indices, nunca
 * se reintenta el CREATE TABLE -- se emiten *solo* los ALTER TABLE ADD y
 * los CREATE INDEX faltantes, primero las columnas y despues los indices,
 * porque un indice futuro podria apoyarse en una columna nueva. Devuelve
 * los nombres de las tablas creadas (no las reparadas).
 */
export async function migrarDefiniciones(
  definiciones: Definicion[],
  prefijo = 'PHF_',
): Promise<string[]> {
  const pool = await getPool()
  const creadas: string[] = []

  for (const { tabla: tablaBase, ddlTabla, indices, columnas } of definiciones) {
    const tabla = conPrefijo(tablaBase, prefijo)
    const indicesDef = (indices ?? []).map((i) => ({
      nombre: conPrefijo(i.nombre, prefijo),
      ddl: conPrefijo(i.ddl, prefijo),
    }))

    if (!(await existeTabla(pool, tabla))) {
      await conTransaccion(async (tx) => {
        const ddlCompleto = [conPrefijo(ddlTabla, prefijo), ...indicesDef.map((i) => i.ddl)].join('\n')
        await tx.request().batch(ddlCompleto)
      })
      creadas.push(tabla)
      continue
    }

    const columnasDef = (columnas ?? []).map((x) => ({
      nombre: conPrefijo(x.nombre, prefijo),
      ddl: conPrefijo(x.ddl, prefijo),
    }))

    // Las columnas van antes que los indices: un indice futuro podria
    // apoyarse en una columna nueva.
    const colFaltantes = await columnasFaltantes(
      pool,
      tabla,
      columnasDef.map((x) => x.nombre),
    )
    if (colFaltantes.length > 0) {
      await conTransaccion(async (tx) => {
        // Un solo ADD con todas: SQL Server lo resuelve en una pasada, y
        // asi no queda una tabla a medio migrar si falla la tercera.
        const lista = columnasDef
          .filter((x) => colFaltantes.includes(x.nombre))
          .map((x) => x.ddl)
          .join(', ')
        await tx.request().batch(`ALTER TABLE ${tabla} ADD ${lista}`)
      })
    }

    const faltantes = await indicesFaltantes(
      pool,
      tabla,
      indicesDef.map((i) => i.nombre),
    )
    if (faltantes.length === 0) continue

    await conTransaccion(async (tx) => {
      const ddlIndicesFaltantes = indicesDef
        .filter((i) => faltantes.includes(i.nombre))
        .map((i) => i.ddl)
        .join('\n')
      await tx.request().batch(ddlIndicesFaltantes)
    })
  }

  return creadas
}

/** Crea las cuatro tablas propias que falten. Devuelve los nombres de las creadas. */
export async function migrar(prefijo = 'PHF_'): Promise<string[]> {
  return migrarDefiniciones(DEFINICIONES, prefijo)
}

// Deteccion de ejecucion directa (vs. import desde los tests). Comparar
// contra process.argv[1] con string matching es fragil entre shells de
// Windows (backslashes vs. forward slashes, rutas relativas, resolucion
// distinta segun el invocador). path.resolve() normaliza ambos lados al
// mismo formato de ruta de sistema de archivos antes de comparar.
function esEjecucionDirecta(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    const esteArchivo = path.resolve(fileURLToPath(import.meta.url))
    const scriptInvocado = path.resolve(argv1)
    return esteArchivo === scriptInvocado
  } catch {
    return false
  }
}

if (esEjecucionDirecta()) {
  migrar()
    .then((creadas) => {
      if (creadas.length === 0) console.log('Esquema al dia, no habia nada que crear.')
      else console.log(`Tablas creadas: ${creadas.join(', ')}`)
    })
    .catch((err) => {
      console.error('Fallo la migracion:', err.message)
      process.exitCode = 1
    })
    .finally(() => cerrarPool())
}
