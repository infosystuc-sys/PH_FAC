import sql from 'mssql'
import { getPool } from './pool'

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
    const r = await fn(tx)
    await tx.commit()
    return r
  } catch (err) {
    try {
      await tx.rollback()
    } catch {
      // La transaccion ya podia estar abortada por el motor.
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
    return await fn(tx)
  } finally {
    await tx.rollback().catch(() => {})
  }
}
