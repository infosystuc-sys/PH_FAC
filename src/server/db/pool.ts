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
      // Tango guarda importes en tipos DECIMAL_TG. Sin esto, mssql
      // devuelve strings para decimales de alta precision.
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
