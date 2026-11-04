import sql from 'mssql'
import { getPool } from '../db/pool'
import type { Serie } from '@/lib/series'

/**
 * Los números de serie de los artículos que los usan (`STA11.USA_SERIE`),
 * al entrar por un remito de proveedor. Pedido del usuario, 2026-11-04.
 *
 * Tango los guarda en dos tablas de Stock, las dos en la documentación
 * oficial de Axoft:
 *
 * - `STA07` es el historial: una fila por serie y por renglón de
 *   movimiento (`TCOMP_IN_S` + `NCOMP_IN_S` + `N_RENGL_S` + `N_SERIE` es su
 *   clave única). En los 1.444 renglones `RP` que Tango ya grabó, el
 *   `N_RENGL_S` y el `COD_ARTICU` coinciden siempre con los de `STA20`.
 * - `STA06` son las series EN STOCK: una fila por artículo + serie +
 *   depósito (clave única). La venta la saca; por eso hoy tiene solo un
 *   puñado de filas aunque `STA07` tenga 1.444 entradas.
 *
 * Cómo graba Tango cada columna, copiado del remito 00004210 (cargado a
 * mano desde Tango para tomarlo de referencia) y de los 1.444 reales:
 * `FILLER`, `COMENTARIO` y `N_PARTIDA` van en `''` cuando no hay dato, nunca
 * en NULL; `COD_DEPOSI` es el depósito del renglón; `DESC1`, `DESC2` y
 * `COMENTARIO` son texto libre del operador. Ningún trigger las toca.
 */

type Ejecutor = { request(): sql.Request }

/** Cuáles de estos artículos usan número de serie. */
export async function articulosConSerie(codigos: string[], e?: Ejecutor): Promise<Set<string>> {
  const unicos = [...new Set(codigos.map((c) => c.trim()).filter((c) => c !== ''))]
  if (unicos.length === 0) return new Set()
  const ej = e ?? (await getPool())
  const req = ej.request()
  const marcas = unicos.map((c, i) => {
    req.input(`a${i}`, sql.VarChar(15), c)
    return `@a${i}`
  })
  const r = await req.query(`
    SELECT LTRIM(RTRIM(COD_ARTICU)) AS COD_ARTICU
    FROM STA11 WHERE COD_ARTICU IN (${marcas.join(', ')}) AND USA_SERIE = 1`)
  return new Set(r.recordset.map((x: { COD_ARTICU: string }) => String(x.COD_ARTICU)))
}

/**
 * De estas series del artículo, las que Tango ya tiene en stock, en
 * cualquier depósito. Una serie identifica una unidad física: si ya está
 * en stock, no puede volver a entrar.
 */
export async function seriesYaEnStock(
  codArticu: string,
  series: string[],
  e?: Ejecutor,
): Promise<{ nSerie: string; deposito: string }[]> {
  if (series.length === 0) return []
  const ej = e ?? (await getPool())
  const req = ej.request().input('art', sql.VarChar(15), codArticu.trim())
  const marcas = series.map((s, i) => {
    req.input(`s${i}`, sql.VarChar(30), s)
    return `@s${i}`
  })
  const r = await req.query(`
    SELECT LTRIM(RTRIM(N_SERIE)) AS N_SERIE, LTRIM(RTRIM(ISNULL(COD_DEPOSI, ''))) AS COD_DEPOSI
    FROM STA06 WHERE COD_ARTICU = @art AND N_SERIE IN (${marcas.join(', ')})`)
  return r.recordset.map((x: { N_SERIE: string; COD_DEPOSI: string }) => ({
    nSerie: String(x.N_SERIE),
    deposito: String(x.COD_DEPOSI),
  }))
}

/**
 * Graba las series de un renglón de remito de proveedor: una fila en
 * `STA07` y una en `STA06` por serie. Va dentro de la transacción del
 * registro, después del `INSERT` en `STA20` del mismo renglón.
 */
export async function grabarSeriesRemitoEn(
  tx: sql.Transaction,
  r: { ncompInS: string; nRenglS: number; codArticu: string; deposito: string; series: Serie[] },
): Promise<void> {
  const enStock = await seriesYaEnStock(r.codArticu, r.series.map((s) => s.nSerie), tx)
  if (enStock.length > 0) {
    throw new Error(
      `El artículo ${r.codArticu} ya tiene en stock la serie ${enStock[0].nSerie} ` +
        `(depósito ${enStock[0].deposito}).`,
    )
  }
  for (const s of r.series) {
    await tx.request()
      .input('art', sql.VarChar(15), r.codArticu)
      .input('desc1', sql.VarChar(25), s.desc1)
      .input('desc2', sql.VarChar(25), s.desc2)
      .input('serie', sql.VarChar(30), s.nSerie)
      .input('comentario', sql.VarChar(25), s.comentario)
      .input('dep', sql.VarChar(2), r.deposito)
      .input('ncompInS', sql.VarChar(8), r.ncompInS)
      .input('nRenglS', sql.Int, r.nRenglS)
      .query(`
        INSERT INTO STA07 (
          FILLER, COD_ARTICU, DESC1, DESC2, N_RENGL_S, N_SERIE, NCOMP_IN_S, TCOMP_IN_S,
          COD_DEPOSI, COMENTARIO, N_PARTIDA
        ) VALUES (
          '', @art, @desc1, @desc2, @nRenglS, @serie, @ncompInS, 'RP',
          @dep, @comentario, ''
        );
        INSERT INTO STA06 (FILLER, COD_ARTICU, DESC1, DESC2, N_SERIE, COD_DEPOSI, COMENTARIO, N_PARTIDA)
        VALUES ('', @art, @desc1, @desc2, @serie, @dep, @comentario, '');`)
  }
}
