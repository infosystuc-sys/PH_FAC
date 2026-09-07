import { getPool } from '../db/pool'

/**
 * `CPA10`, los parámetros del módulo de Compras. Figura en la documentación
 * oficial de Axoft para Compras como "Parámetros". Solo lectura.
 *
 * Tiene exactamente una fila -- verificado contra la base --, que es como
 * Tango guarda la configuración del módulo.
 */

/**
 * La fecha "vacía" de Tango. `CIERRE_EMI` y `CIERRE_PAG` la traen cuando no
 * hay cierre cargado, y es el mismo valor que usa el registro de
 * comprobantes (`SIN_FECHA` en comprobantes.ts).
 */
const SIN_FECHA = new Date('1800-01-01T03:53:48.000Z')

function esSinFecha(d: Date): boolean {
  return d.getFullYear() <= 1800
}

/**
 * Hasta qué fecha está cerrado contablemente el módulo de Compras
 * (`CPA10.CIERRE_CON`), o `null` si no hay cierre.
 *
 * Es lo que decide la fecha contable de un comprobante -- ver
 * `fechaContableDe` en `src/lib/fechaContable.ts`.
 */
export async function cierreContable(): Promise<Date | null> {
  const pool = await getPool()
  const r = await pool.request().query<{ cierre: Date | null }>(`
    SELECT TOP 1 CIERRE_CON AS cierre FROM CPA10
  `)

  const fila = r.recordset[0]
  if (!fila?.cierre) return null
  const cierre = new Date(fila.cierre)
  return esSinFecha(cierre) || Number.isNaN(cierre.getTime()) ? null : cierre
}

export { SIN_FECHA as SIN_FECHA_TANGO }
