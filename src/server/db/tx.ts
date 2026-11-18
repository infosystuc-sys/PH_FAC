import sql from 'mssql'
import { getPool } from './pool'

/**
 * Cada transaccion arranca diciendo explicitamente como corre XACT_ABORT.
 *
 * El registro en Tango corre con `SET XACT_ABORT ON` (2026-11-17, punto 6 de
 * la revision contra Tango): un error de SQL o un timeout del cliente
 * aborta la transaccion entera en el servidor y suelta los bloqueos, en vez
 * de dejarla abierta en la conexion hasta que llegue el rollback.
 *
 * `SET` es de la SESION, no de la transaccion, y mssql devuelve la conexion
 * al pool sin resetearla: sin esto, la proxima transaccion que tome esa
 * conexion heredaria el ON sin saberlo. Por eso cada una lo fija al empezar
 * (OFF por defecto, como venia corriendo todo lo demas).
 *
 * Va con `.batch()` y no con `.query()`: mssql corre `.query()` con
 * `sp_executesql`, y un `SET` adentro de `sp_executesql` se revierte al
 * terminar la llamada -- no quedaria vigente para las sentencias siguientes.
 */
export async function fijarXactAbort(tx: sql.Transaction, on: boolean): Promise<void> {
  await tx.request().batch(on ? 'SET XACT_ABORT ON' : 'SET XACT_ABORT OFF')
}

/**
 * Corre `fn` dentro de una transaccion. Commit si termina bien,
 * rollback si lanza. El error original se propaga.
 */
export async function conTransaccion<T>(
  fn: (tx: sql.Transaction) => Promise<T>,
  nivel: sql.IIsolationLevel = sql.ISOLATION_LEVEL.READ_COMMITTED,
): Promise<T> {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin(nivel)
  try {
    await fijarXactAbort(tx, false)
    const r = await fn(tx)
    await tx.commit()
    return r
  } catch (err) {
    try {
      await tx.rollback()
    } catch {
      // La transaccion ya podia estar abortada por el motor (con XACT_ABORT
      // ON, mssql la da por terminada y ya devolvio la conexion).
    }
    throw err
  }
}

/**
 * Igual que conTransaccion pero siempre hace rollback.
 * Es para tests que necesitan escribir sin dejar rastro.
 */
export async function conRollback<T>(
  fn: (tx: sql.Transaction) => Promise<T>,
): Promise<T> {
  const pool = await getPool()
  const tx = new sql.Transaction(pool)
  await tx.begin()
  try {
    await fijarXactAbort(tx, false)
    return await fn(tx)
  } finally {
    await tx.rollback().catch(() => {})
  }
}
