import sql from 'mssql'

function leerConfig(): sql.config {
  const req = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`Falta la variable de entorno ${k}`)
    return v
  }

  return {
    server: req('SQLSERVER_HOST'),
    database: req('SQLSERVER_DB'),
    user: req('SQLSERVER_USER'),
    password: req('SQLSERVER_PASSWORD'),
    options: {
      instanceName: process.env.SQLSERVER_INSTANCE || undefined,
      encrypt: false,
      trustServerCertificate: true,
      // Con el default (true), mssql interpreta las columnas DATE/DATETIME
      // como UTC: un DATE guardado como 2026-05-18 vuelve como
      // 2026-05-18T00:00:00Z, y formatFecha usa getDate()/getMonth() en
      // hora local, asi que en Argentina (UTC-3) se mostraria 17/05/2026.
      // false le dice a mssql que interprete esas columnas en hora local,
      // que es como Tango las guarda. No tiene relacion con precision
      // decimal: eso lo maneja el tipo de columna, no esta opcion.
      useUTC: false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 15000,
  }
}

let poolPromise: Promise<sql.ConnectionPool> | null = null

export function getPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(leerConfig())
      .connect()
      .catch((err) => {
        poolPromise = null
        throw err
      })
  }
  return poolPromise
}

export async function cerrarPool(): Promise<void> {
  if (!poolPromise) return
  const pool = await poolPromise
  poolPromise = null
  await pool.close()
}

export type ResultadoConexion =
  | { ok: true; version: string }
  | { ok: false; error: string }

export async function probarConexion(): Promise<ResultadoConexion> {
  try {
    const pool = await getPool()
    const r = await pool.request().query('SELECT @@VERSION AS v')
    return { ok: true, version: String(r.recordset[0].v) }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    console.error('probarConexion: fallo la conexion a SQL Server:', mensaje)
    return { ok: false, error: mensaje }
  }
}
