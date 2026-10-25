import sql from 'mssql'
import { getPool } from '../db/pool'

/**
 * Tango no tiene el mismo esquema en todas las bases. `PUNTO_HOGAR_1` es una
 * version reciente, con claves sustitutas `ID_*` (ID_CPA45, ID_STA11,
 * ID_CPA01, ...) y tablas como ESTADO_ORDEN_COMPRA; `CENTRAL` es una version
 * anterior que enlaza todo por codigo y no tiene nada de eso. En vez de
 * fijar la app a una de las dos, las consultas que difieren le preguntan
 * aca a la base a la que estan conectadas.
 *
 * La respuesta se guarda por base: el esquema no cambia mientras corre el
 * proceso, y la clave incluye el nombre de la base por si una prueba apunta
 * el pool a otra.
 */
const cache = new Map<string, boolean>()

async function existe(clave: string, consulta: string, tabla: string, columna?: string) {
  const base = `${process.env.SQLSERVER_DB}|${clave}`
  const guardado = cache.get(base)
  if (guardado !== undefined) return guardado

  const pool = await getPool()
  const r = await pool
    .request()
    .input('tabla', sql.VarChar(128), tabla)
    .input('columna', sql.VarChar(128), columna ?? null)
    .query(consulta)
  const hay = r.recordset.length > 0
  cache.set(base, hay)
  return hay
}

export function tieneColumna(tabla: string, columna: string): Promise<boolean> {
  return existe(
    `${tabla}.${columna}`,
    `SELECT TOP 1 1 AS x FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME = @tabla AND COLUMN_NAME = @columna`,
    tabla,
    columna,
  )
}

export function tieneTabla(tabla: string): Promise<boolean> {
  return existe(
    tabla,
    `SELECT TOP 1 1 AS x FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @tabla`,
    tabla,
  )
}
