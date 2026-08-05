import { config as cargarEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'

cargarEnv({ path: '.env.local' })

type Definicion = { tabla: string; ddl: string; indices?: string[] }

const DEFINICIONES: Definicion[] = [
  {
    tabla: 'PHF_COMPROBANTE',
    ddl: `
      CREATE TABLE PHF_COMPROBANTE (
        ID                  INT IDENTITY(1,1) NOT NULL,
        ARCHIVO_NOMBRE      NVARCHAR(260)  NOT NULL,
        ARCHIVO_RUTA        NVARCHAR(500)  NOT NULL,
        ARCHIVO_HASH        CHAR(64)       NOT NULL,
        ESTADO              VARCHAR(20)    NOT NULL,
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
        FECHA_ALTA          DATETIME2      NOT NULL CONSTRAINT DF_PHF_COMP_ALTA DEFAULT SYSDATETIME(),
        USUARIO_ALTA        NVARCHAR(60)   NOT NULL,
        FECHA_MODIF         DATETIME2      NULL,
        USUARIO_MODIF       NVARCHAR(60)   NULL,
        CONSTRAINT PK_PHF_COMPROBANTE PRIMARY KEY (ID),
        CONSTRAINT CK_PHF_COMP_ESTADO CHECK (ESTADO IN
          ('procesando','leido','observacion','confirmado','registrado','error'))
      );
      CREATE INDEX IX_PHF_COMP_ESTADO ON PHF_COMPROBANTE (ESTADO);
      CREATE INDEX IX_PHF_COMP_DUP ON PHF_COMPROBANTE (COD_PROVEE, TIPO, NUMERO);
      CREATE INDEX IX_PHF_COMP_CUIT ON PHF_COMPROBANTE (CUIT);
    `,
    indices: ['IX_PHF_COMP_ESTADO', 'IX_PHF_COMP_DUP', 'IX_PHF_COMP_CUIT'],
  },
  {
    tabla: 'PHF_CAMPO',
    ddl: `
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
    ddl: `
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
        CONSTRAINT PK_PHF_RENGLON PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_RENGLON UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_RENGLON_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    tabla: 'PHF_AUDITORIA',
    ddl: `
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
      CREATE INDEX IX_PHF_AUD_COMP ON PHF_AUDITORIA (COMPROBANTE_ID, FECHA);
    `,
    indices: ['IX_PHF_AUD_COMP'],
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

/** true si a la tabla le falta alguno de los indices esperados (o la tabla misma). */
async function tablaIncompleta(
  pool: sql.ConnectionPool,
  tabla: string,
  indicesEsperados: string[],
): Promise<boolean> {
  if (!(await existeTabla(pool, tabla))) return true
  if (indicesEsperados.length === 0) return false

  const req = pool.request().input('t', tabla)
  const placeholders = indicesEsperados.map((nombre, i) => {
    req.input(`i${i}`, nombre)
    return `@i${i}`
  })
  const r = await req.query(`
    SELECT COUNT(*) AS n
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    WHERE t.name = @t AND i.name IN (${placeholders.join(', ')})
  `)
  return Number(r.recordset[0].n) < indicesEsperados.length
}

/**
 * Crea las tablas que falten (tabla ausente o con algun indice esperado
 * faltante). Cada tabla se crea en su propia transaccion: si el CREATE
 * TABLE pasa pero un CREATE INDEX del mismo batch falla, el rollback se
 * lleva puesta tambien la tabla, para que la proxima corrida la vuelva a
 * intentar completa en lugar de saltearla para siempre por el chequeo de
 * idempotencia. Devuelve los nombres de las tablas creadas.
 */
export async function migrarDefiniciones(
  definiciones: Definicion[],
  prefijo = 'PHF_',
): Promise<string[]> {
  const pool = await getPool()
  const creadas: string[] = []

  for (const { tabla: tablaBase, ddl, indices } of definiciones) {
    const tabla = conPrefijo(tablaBase, prefijo)
    const indicesEsperados = (indices ?? []).map((i) => conPrefijo(i, prefijo))

    if (!(await tablaIncompleta(pool, tabla, indicesEsperados))) continue

    await conTransaccion(async (tx) => {
      await tx.request().batch(conPrefijo(ddl, prefijo))
    })
    creadas.push(tabla)
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
