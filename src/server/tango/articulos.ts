import sql from 'mssql'
import { getPool } from '../db/pool'

export type ArticuloTango = {
  codArticu: string
  descripcion: string
  descAdic: string | null
  codBarra: string | null
  sinonimo: string | null
  /** Por qué campo se encontró. Se le muestra al operador. */
  porQue: string
}

/**
 * Busca un artículo en el maestro de Tango para que el operador corrija a
 * mano un renglón mal emparejado.
 *
 * El orden de los campos no es caprichoso, sale de medir la base:
 *
 *   COD_BARRA    el EAN es el único identificador que no depende de quién
 *                lo venda, así que un match ahí es exacto y sin ambigüedad.
 *                Cargado en el 29% del maestro.
 *   COD_ARTICU   nuestro código, 100% cargado. Algunos proveedores lo
 *                imprimen tal cual (TOPPER factura "27383 001" y nosotros
 *                lo tenemos como "27383  001 27").
 *   SINONIMO     67% del maestro.
 *   DESCRIPCIO   100%, pero AMBIGUO: 1.046 descripciones se repiten entre
 *                varios artículos y una la comparten 33. Va al final y
 *                nunca sola -- por eso se devuelve `porQue`, para que el
 *                operador vea que ese match es por texto y desconfíe.
 *   DESC_ADIC    90%, y es lo que distingue color y talle ("NEGRO T 27").
 *
 * CPA15 queda AFUERA a propósito. Sería el lugar natural -- es la tabla de
 * artículos por proveedor -- pero de sus 539 filas solo 2 tienen cargado
 * COD_SINONI, el código con el que el proveedor lo llama. Registra a quién
 * le compramos cada artículo, no cómo lo nombra: como llave de búsqueda
 * desde el papel resolvería dos casos en toda la base. Si algún día se
 * cargan esos códigos, va primera.
 */
const MAX_RESULTADOS = 25

export async function buscarArticulos(texto: string): Promise<ArticuloTango[]> {
  const t = texto.trim()
  if (t.length < 2) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('exacto', sql.VarChar(60), t)
    .input('like', sql.VarChar(62), `${t}%`)
    .input('contiene', sql.NVarChar(64), `%${t}%`)
    .input('lim', sql.Int, MAX_RESULTADOS)
    .query<Record<string, unknown>>(`
      SELECT TOP (@lim)
        LTRIM(RTRIM(a.COD_ARTICU))             AS codArticu,
        LTRIM(RTRIM(ISNULL(a.DESCRIPCIO,'')))  AS descripcion,
        LTRIM(RTRIM(ISNULL(a.DESC_ADIC,'')))   AS descAdic,
        LTRIM(RTRIM(ISNULL(a.COD_BARRA,'')))   AS codBarra,
        LTRIM(RTRIM(ISNULL(a.SINONIMO,'')))    AS sinonimo,
        CASE
          WHEN LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto THEN 'código de barras'
          WHEN LTRIM(RTRIM(a.COD_ARTICU))          = @exacto THEN 'código de artículo'
          WHEN LTRIM(RTRIM(ISNULL(a.SINONIMO,''))) = @exacto THEN 'sinónimo'
          WHEN LTRIM(RTRIM(a.COD_ARTICU)) LIKE @like         THEN 'código de artículo'
          ELSE 'descripción'
        END AS porQue,
        CASE
          WHEN LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto THEN 1
          WHEN LTRIM(RTRIM(a.COD_ARTICU))          = @exacto THEN 2
          WHEN LTRIM(RTRIM(ISNULL(a.SINONIMO,''))) = @exacto THEN 3
          WHEN LTRIM(RTRIM(a.COD_ARTICU)) LIKE @like         THEN 4
          ELSE 5
        END AS prioridad
      FROM STA11 a
      WHERE LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto
         OR LTRIM(RTRIM(a.COD_ARTICU))           = @exacto
         OR LTRIM(RTRIM(ISNULL(a.SINONIMO,'')))  = @exacto
         OR LTRIM(RTRIM(a.COD_ARTICU))    LIKE @like
         OR a.DESCRIPCIO                  LIKE @contiene
         OR a.DESC_ADIC                   LIKE @contiene
      ORDER BY prioridad, a.COD_ARTICU
    `)

  return r.recordset.map((x) => ({
    codArticu: String(x.codArticu),
    descripcion: String(x.descripcion),
    descAdic: x.descAdic ? String(x.descAdic) : null,
    codBarra: x.codBarra ? String(x.codBarra) : null,
    sinonimo: x.sinonimo ? String(x.sinonimo) : null,
    porQue: String(x.porQue),
  }))
}
