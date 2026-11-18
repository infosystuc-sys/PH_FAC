import sql from 'mssql'
import { fijarXactAbort } from '../db/tx'
import { clasificarDnrpa, esSinDnrpa, type ClasificacionDnrpa, type FilaSerie } from '@/lib/dnrpa'

/**
 * El DNRPA de las motos en las series de Tango (2026-11-18, pedido del
 * usuario). Va a `COMENTARIO` de `STA06` (la serie en stock) y de TODAS las
 * filas de `STA07` de esa serie (su historial de movimientos: la compra y,
 * si ya se vendió, la venta) -- decisión del usuario.
 *
 * Intercalación: `N_SERIE` y `COD_ARTICU` son `Latin1_General_BIN` y
 * `COMENTARIO` es `Modern_Spanish_CI_AI` en las dos tablas. La serie se
 * busca con parámetro, ya normalizada (sin espacios y en mayúsculas, como la
 * graba la app y como la muestra Tango), y los comentarios se comparan en
 * JavaScript, no en SQL.
 *
 * Ningún trigger toca estas dos tablas (verificado en desarrollo el
 * 2026-11-18). Ver la regla de qué se pisa en `src/lib/dnrpa.ts`.
 */

type Ejecutor = { request(): sql.Request }

/** Las filas de STA06 y STA07 de cada serie, por serie normalizada. */
export async function filasDeSeriesEn(
  e: Ejecutor,
  series: string[],
  bloquear = false,
): Promise<Map<string, FilaSerie[]>> {
  const resultado = new Map<string, FilaSerie[]>()
  const unicas = [...new Set(series.filter((s) => s !== ''))]
  for (const s of unicas) resultado.set(s, [])
  const lock = bloquear ? 'WITH (UPDLOCK, ROWLOCK)' : ''
  // De a 200 por consulta: el limite de parametros de SQL Server es 2.100.
  for (let i = 0; i < unicas.length; i += 200) {
    const lote = unicas.slice(i, i + 200)
    const req = e.request()
    const marcas = lote.map((s, j) => {
      req.input(`s${j}`, sql.VarChar(30), s)
      return `@s${j}`
    })
    const r = await req.query(`
      SELECT 'STA06' AS tabla, LTRIM(RTRIM(N_SERIE)) AS serie, LTRIM(RTRIM(COD_ARTICU)) AS art,
             ISNULL(COMENTARIO, '') AS comentario
      FROM STA06 ${lock} WHERE N_SERIE IN (${marcas.join(', ')})
      UNION ALL
      SELECT 'STA07', LTRIM(RTRIM(N_SERIE)), LTRIM(RTRIM(COD_ARTICU)), ISNULL(COMENTARIO, '')
      FROM STA07 ${lock} WHERE N_SERIE IN (${marcas.join(', ')})`)
    for (const f of r.recordset as { tabla: 'STA06' | 'STA07'; serie: string; art: string; comentario: string }[]) {
      resultado.get(f.serie)?.push({ tabla: f.tabla, codArticu: f.art, comentario: String(f.comentario) })
    }
  }
  return resultado
}

export type ResultadoGrabarDnrpa = {
  chasis: string
  dnrpa: string
  clasificacion: ClasificacionDnrpa
  /** Filas actualizadas: las de la serie que no tenían DNRPA. */
  sta06: number
  sta07: number
}

/**
 * Graba el DNRPA de cada serie, dentro de la transacción del que llama.
 * Vuelve a leer las filas con bloqueo y a clasificar: entre la vista previa
 * y la confirmación alguien pudo haber cargado otro comentario desde Tango.
 * Solo escribe en las filas sin DNRPA (vacías o con la propia serie), y solo
 * si la serie sigue en estado `cargar`.
 */
export async function grabarDnrpaEn(
  tx: sql.Transaction,
  items: { chasis: string; dnrpa: string }[],
): Promise<ResultadoGrabarDnrpa[]> {
  await fijarXactAbort(tx, true)
  const filas = await filasDeSeriesEn(tx, items.map((i) => i.chasis), true)
  const resultado: ResultadoGrabarDnrpa[] = []
  for (const { chasis, dnrpa } of items) {
    const deLaSerie = filas.get(chasis) ?? []
    const clasificacion = clasificarDnrpa(chasis, dnrpa, deLaSerie)
    let sta06 = 0
    let sta07 = 0
    if (clasificacion.estado === 'cargar') {
      // Los comentarios a reemplazar, tal cual estan en la base: la serie o
      // vacio. Se pasan como parametro para no comparar entre intercalaciones.
      const reemplazables = [
        ...new Set(deLaSerie.filter((f) => esSinDnrpa(f.comentario, chasis)).map((f) => f.comentario)),
      ]
      for (const tabla of ['STA06', 'STA07'] as const) {
        if (!deLaSerie.some((f) => f.tabla === tabla && esSinDnrpa(f.comentario, chasis))) continue
        const req = tx.request()
          .input('serie', sql.VarChar(30), chasis)
          .input('art', sql.VarChar(15), clasificacion.codArticu)
          .input('dnrpa', sql.VarChar(25), dnrpa)
        const marcas = reemplazables.map((c, j) => {
          req.input(`c${j}`, sql.VarChar(25), c)
          return `@c${j}`
        })
        const r = await req.query(`
          UPDATE ${tabla} SET COMENTARIO = @dnrpa
          WHERE N_SERIE = @serie AND COD_ARTICU = @art
            AND (COMENTARIO IS NULL OR COMENTARIO IN (${marcas.join(', ')}))`)
        if (tabla === 'STA06') sta06 = r.rowsAffected[0] ?? 0
        else sta07 = r.rowsAffected[0] ?? 0
      }
    }
    resultado.push({ chasis, dnrpa, clasificacion, sta06, sta07 })
  }
  return resultado
}
