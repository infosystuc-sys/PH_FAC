import sql from 'mssql'
import { getPool } from '../db/pool'
import { normalizarCodigo } from '@/lib/cotejoOc'

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
 * CPA15 va PRIMERA cuando se sabe de qué proveedor es el comprobante. Es la
 * tabla de artículos por proveedor y `COD_SINONI` guarda el código con el
 * que ese proveedor lo llama, que es justo lo que imprime la factura. Hoy
 * está cargada en 2 de 539 filas -- por eso el resto de la cascada sigue
 * existiendo --, pero `asociarArticuloProveedor` la va llenando cada vez
 * que el operador corrige un renglón, así que gana precisión con el uso.
 */
const MAX_RESULTADOS = 25

export async function buscarArticulos(
  texto: string,
  codProvee?: string | null,
): Promise<ArticuloTango[]> {
  const t = texto.trim()
  if (t.length < 2) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), codProvee?.trim() || null)
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
          WHEN sin.COD_ARTICU IS NOT NULL                     THEN 'código del proveedor'
          WHEN LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto THEN 'código de barras'
          WHEN LTRIM(RTRIM(a.COD_ARTICU))          = @exacto THEN 'código de artículo'
          WHEN LTRIM(RTRIM(ISNULL(a.SINONIMO,''))) = @exacto THEN 'sinónimo'
          WHEN LTRIM(RTRIM(a.COD_ARTICU)) LIKE @like         THEN 'código de artículo'
          ELSE 'descripción'
        END AS porQue,
        CASE
          WHEN sin.COD_ARTICU IS NOT NULL                     THEN 0
          WHEN LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto THEN 1
          WHEN LTRIM(RTRIM(a.COD_ARTICU))          = @exacto THEN 2
          WHEN LTRIM(RTRIM(ISNULL(a.SINONIMO,''))) = @exacto THEN 3
          WHEN LTRIM(RTRIM(a.COD_ARTICU)) LIKE @like         THEN 4
          ELSE 5
        END AS prioridad
      FROM STA11 a
      -- El codigo con el que ESTE proveedor llama al articulo. Es la unica
      -- llave pensada para esto, asi que gana sobre todo lo demas.
      LEFT JOIN CPA15 sin
        ON sin.COD_ARTICU = a.COD_ARTICU
       AND @prov IS NOT NULL
       AND LTRIM(RTRIM(sin.COD_PROVEE)) = @prov
       AND LTRIM(RTRIM(ISNULL(sin.COD_SINONI,''))) = @exacto
      WHERE sin.COD_ARTICU IS NOT NULL
         OR LTRIM(RTRIM(ISNULL(a.COD_BARRA,''))) = @exacto
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

/**
 * Enseña a Tango cómo llama este proveedor a un artículo nuestro, para que
 * la próxima factura se empareje sola.
 *
 * Escribe `CPA15.COD_SINONI`, que es la función que el ERP tiene prevista
 * para esto: la tabla tiene dos índices propios sobre ese campo,
 * `(COD_SINONI, COD_PROVEE)` y su inverso, que existen justamente para
 * buscar por el código del proveedor.
 *
 * Es un UPSERT porque `IX_0` es único en `(COD_PROVEE, COD_ARTICU)`: un
 * artículo tiene una sola fila por proveedor. Y lo normal es el UPDATE --
 * de los artículos que TOPPER facturó, 57 de 61 ya tenían fila con
 * `COD_SINONI` vacío. Tango registra a quién le compramos cada cosa aunque
 * no sepa cómo la nombra.
 *
 * `ID_CPA15` se omite a propósito en el INSERT: su default es
 * `NEXT VALUE FOR [SEQUENCE_CPA15]`, la secuencia con la que numera Tango.
 * Calcularlo con MAX+1 chocaría con lo que el ERP asigne después.
 * `USA_ESC` se copia de STA11 -- espeja exacto en las 539 filas -- y
 * `PROV_HABITUAL` se deja en su default 'N': marcar a un proveedor como
 * habitual es una decisión de compras, no algo que se deduzca de haber
 * corregido un renglón.
 */
export async function asociarArticuloProveedor(
  codProvee: string,
  codArticu: string,
  codSinoni: string,
): Promise<void> {
  const prov = codProvee.trim()
  const art = codArticu.trim()
  const sinonimo = codSinoni.trim()
  if (!prov || !art || !sinonimo) return

  const pool = await getPool()
  await pool
    .request()
    .input('prov', sql.VarChar(6), prov)
    .input('art', sql.VarChar(15), art)
    .input('sin', sql.VarChar(15), sinonimo.slice(0, 15))
    .query(`
      MERGE CPA15 WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE, @art AS COD_ARTICU) AS origen
        ON  LTRIM(RTRIM(destino.COD_PROVEE)) = origen.COD_PROVEE
        AND LTRIM(RTRIM(destino.COD_ARTICU)) = origen.COD_ARTICU
      WHEN MATCHED THEN
        UPDATE SET COD_SINONI = @sin
      WHEN NOT MATCHED THEN
        INSERT (COD_ARTICU, COD_PROVEE, COD_SINONI, USA_ESC, ID_STA11, ID_CPA01,
                COD_CPA01_PROVEEDOR)
        VALUES (
          @art, @prov, @sin,
          ISNULL((SELECT LTRIM(RTRIM(ISNULL(USA_ESC,'N'))) FROM STA11 WHERE COD_ARTICU = @art), 'N'),
          (SELECT ID_STA11 FROM STA11 WHERE COD_ARTICU = @art),
          (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE = @prov),
          @prov
        );
    `)
}

/**
 * La vuelta de `sinonimosDelProveedor`: del código que IMPRIME el proveedor
 * al artículo nuestro. Es la dirección que hace falta para leer una factura
 * -- lo único que se tiene es lo impreso, y hay que averiguar qué artículo
 * es -- y `CPA15` está indexada justamente así, por `(COD_SINONI,
 * COD_PROVEE)`.
 *
 * Se pide el proveedor y no solo el sinónimo porque el mismo código puede
 * significar cosas distintas según quién lo escriba: `COD_SINONI` es único
 * dentro de un proveedor, no en toda la tabla.
 *
 * La comparación es en mayúsculas y sin espacios de los dos lados. `CPA15`
 * está en `Latin1_General_BIN`, que distingue mayúsculas, y el código sale
 * de un PDF transcripto por el modelo: exigir que coincida byte a byte
 * dejaría sin emparejar un artículo que sí está cargado.
 */
export async function articulosPorSinonimo(
  codProvee: string,
  sinonimos: string[],
): Promise<Map<string, string>> {
  const prov = codProvee.trim()
  const buscados = new Set(sinonimos.map(normalizarCodigo).filter((x) => x !== ''))
  if (!prov || buscados.size === 0) return new Map()

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), prov)
    .query<Record<string, unknown>>(`
      SELECT LTRIM(RTRIM(COD_ARTICU)) AS art, LTRIM(RTRIM(COD_SINONI)) AS sinonimo
      FROM CPA15
      WHERE LTRIM(RTRIM(COD_PROVEE)) = @prov
        AND LTRIM(RTRIM(ISNULL(COD_SINONI,''))) <> ''
    `)

  const m = new Map<string, string>()
  for (const f of r.recordset) {
    const sinonimo = normalizarCodigo(String(f.sinonimo))
    if (buscados.has(sinonimo)) m.set(sinonimo, String(f.art))
  }
  return m
}

/**
 * El código con el que un proveedor llama a cada uno de estos artículos.
 * Se le pasa al modelo en la segunda pasada: lo que el operador enseñó una
 * vez, el emparejamiento automático lo aprovecha después.
 */
export async function sinonimosDelProveedor(
  codProvee: string,
  codArticulos: string[],
): Promise<Map<string, string>> {
  const prov = codProvee.trim()
  if (!prov || codArticulos.length === 0) return new Map()

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), prov)
    .query<Record<string, unknown>>(`
      SELECT LTRIM(RTRIM(COD_ARTICU)) AS art, LTRIM(RTRIM(COD_SINONI)) AS sinonimo
      FROM CPA15
      WHERE LTRIM(RTRIM(COD_PROVEE)) = @prov
        AND LTRIM(RTRIM(ISNULL(COD_SINONI,''))) <> ''
    `)

  const pedidos = new Set(codArticulos.map((x) => x.trim()))
  const m = new Map<string, string>()
  for (const f of r.recordset) {
    const art = String(f.art)
    if (pedidos.has(art)) m.set(art, String(f.sinonimo))
  }
  return m
}

/**
 * Cómo participa un artículo de una ESCALA de Tango (`STA11.USA_ESC`).
 *
 * Tango permite definir un artículo "con escala": un código base y una
 * variante por cada combinación de color y/o talle, con el sufijo pegado al
 * final del código. El maestro marca los tres papeles, y la distinción es
 * la que faltaba:
 *
 *   'B' -- BASE. El padre de la escala. NO se factura ni se le lleva stock:
 *          existe para agrupar. Son 337 en el maestro.
 *   'S' -- CON ESCALA. La variante concreta, que es la que se compra y se
 *          factura: `1261095140` (color 140), `167686 001 L` (talle L).
 *          Son 1.934.
 *   'N' -- sin escala. El artículo común. Son 7.294.
 *
 * Sin mirar esto, un código base se veía como un artículo perfectamente
 * válido que casualmente no tenía saldo en ninguna orden, y la app decía
 * "reconocido, sin pendiente de facturar" -- un mensaje que manda al
 * operador a buscar una orden que no existe, cuando lo que falta es el
 * color o el talle. Lo reportó el usuario con DASS (1261095, que es base de
 * 1261095140) el 2026-09-30, y era también la causa del caso TOPPER.
 */
export type Escala = 'base' | 'variante' | 'ninguna'

export function esEscala(valor: unknown): Escala {
  const v = String(valor ?? '').trim().toUpperCase()
  if (v === 'B') return 'base'
  if (v === 'S') return 'variante'
  return 'ninguna'
}

export type ArticuloDescripto = {
  codArticu: string
  descripcion: string
  escala: Escala
}

/**
 * Las variantes de escala de un artículo base que TIENEN saldo pendiente en
 * alguna orden de este proveedor.
 *
 * Es lo que se le ofrece al operador cuando la factura trae el código base:
 * son los únicos artículos contra los que esa línea se puede facturar. Se
 * filtra por proveedor porque un mismo base puede tener variantes pedidas a
 * varios, y ofrecer las de otro proveedor sería ofrecer un error.
 *
 * Medido el 2026-09-30: los 337 bases del maestro tienen entre 1 y 19
 * variantes, con 4 a 10 como caso típico y solo 37 con una sola. Por eso
 * esto DEVUELVE LA LISTA y no adivina: elegir por el operador acertaría en
 * una minoría de los casos.
 */
export async function variantesPendientesDeBase(
  codProvee: string,
  bases: string[],
): Promise<Map<string, ArticuloDescripto[]>> {
  const salida = new Map<string, ArticuloDescripto[]>()
  const prov = codProvee.trim()
  const buscados = [...new Set(bases.map((b) => b.trim()).filter((b) => b !== ''))]
  if (!prov || buscados.length === 0) return salida

  const pool = await getPool()
  const req = pool.request().input('prov', sql.VarChar(6), prov)
  const marcadores = buscados.map((b, i) => {
    req.input(`b${i}`, sql.VarChar(60), b)
    return `@b${i}`
  })

  const r = await req.query<Record<string, unknown>>(`
    SELECT DISTINCT
      LTRIM(RTRIM(a.COD_ARTICU))                     AS codArticu,
      LTRIM(RTRIM(ISNULL(a.DESCRIPCIO, '')))         AS descripcion,
      LTRIM(RTRIM(ISNULL(a.USA_ESC, 'N')))           AS usaEsc,
      b.base                                         AS base
    FROM (VALUES ${marcadores.map((m) => `(${m})`).join(', ')}) AS b(base)
    JOIN CPA36 r ON LTRIM(RTRIM(r.COD_ARTICU)) LIKE b.base + '%'
                AND LEN(LTRIM(RTRIM(r.COD_ARTICU))) > LEN(b.base)
    JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO
    JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
    WHERE LTRIM(RTRIM(h.COD_PROVEE)) = @prov
      AND ISNULL(r.PENDIENTE_FACTURAR, 0) > 0
    ORDER BY b.base, LTRIM(RTRIM(a.COD_ARTICU))
  `)

  for (const f of r.recordset) {
    const base = String(f.base)
    const lista = salida.get(base) ?? []
    lista.push({
      codArticu: String(f.codArticu),
      descripcion: String(f.descripcion),
      escala: esEscala(f.usaEsc),
    })
    salida.set(base, lista)
  }
  return salida
}

/**
 * La descripción de cada uno de estos artículos según el maestro (STA11),
 * o ausente si el código no existe.
 *
 * Sirve para dos cosas en la tarjeta de la orden de compra (2026-09-15):
 * mostrarle al operador qué artículo es un código que se reconoció pero no
 * tiene saldo en ninguna orden, y detectar que un código impreso que no
 * tiene sinónimo es en realidad uno de los NUESTROS -- hay proveedores que
 * facturan con nuestro propio código -- y que tampoco tiene saldo. Sin esto,
 * las dos situaciones se mostraban como "este código no se reconoce".
 */
export async function describirArticulos(
  codigos: string[],
): Promise<Map<string, ArticuloDescripto>> {
  const buscados = [...new Set(codigos.map(normalizarCodigo).filter((c) => c !== ''))]
  // Clave normalizada -> el codigo TAL COMO ESTA en el maestro (con sus
  // espacios, si los tiene) y su descripcion. Lo que se muestra y se graba
  // es el del maestro, nunca la clave.
  const m = new Map<string, ArticuloDescripto>()
  if (buscados.length === 0) return m

  const pool = await getPool()
  const req = pool.request()
  const marcadores = buscados.map((c, i) => {
    // VarChar(60), no el largo de la columna: un codigo impreso mas largo
    // que COD_ARTICU (la IA le pego la alicuota de IVA de la misma celda,
    // paso con NEWSAN el 2026-09-18) hacia explotar al driver por el largo
    // del parametro, y con el a toda la tarjeta de la OC. Uno mas largo
    // simplemente no matchea con nada, que es la respuesta correcta.
    req.input(`c${i}`, sql.VarChar(60), c)
    return `@c${i}`
  })
  const r = await req.query<Record<string, unknown>>(`
    SELECT LTRIM(RTRIM(COD_ARTICU)) AS codArticu, LTRIM(RTRIM(ISNULL(DESCRIPCIO, ''))) AS descripcion,
           LTRIM(RTRIM(ISNULL(USA_ESC, 'N'))) AS usaEsc
    FROM STA11
    -- La misma clave que normalizarCodigo: sin espacio, punto, guion ni
    -- barra, que son los unicos no alfanumericos que hay en los codigos.
    WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(COD_ARTICU), ' ', ''), '.', ''), '-', ''), '/', '') IN (${marcadores.join(', ')})
  `)
  for (const f of r.recordset) {
    m.set(normalizarCodigo(String(f.codArticu)), {
      codArticu: String(f.codArticu),
      descripcion: String(f.descripcion),
      escala: esEscala(f.usaEsc),
    })
  }
  return m
}
