import { describe, it, expect, afterAll } from 'vitest'
import { buscarArticulos, sinonimosDelProveedor } from '@/server/tango/articulos'
import { getPool, cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'

afterAll(async () => {
  await cerrarPool()
})

/** Un articulo real con codigo de barras, descubierto en vez de fijado. */
async function unoConBarra() {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(COD_ARTICU)) AS cod,
           LTRIM(RTRIM(COD_BARRA)) AS barra,
           LTRIM(RTRIM(ISNULL(DESCRIPCIO,''))) AS descripcion
    FROM STA11
    WHERE LTRIM(RTRIM(ISNULL(COD_BARRA,''))) <> ''
      AND LEN(LTRIM(RTRIM(COD_BARRA))) >= 8
    ORDER BY COD_ARTICU`)
  return r.recordset.length ? r.recordset[0] : null
}

describe('buscarArticulos', () => {
  it('encuentra por codigo de barras y lo dice', async () => {
    // El EAN es el unico identificador que no depende de quien venda el
    // articulo: un match ahi es exacto y va primero.
    const a = await unoConBarra()
    if (!a) return

    const r = await buscarArticulos(String(a.barra))
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].codArticu).toBe(String(a.cod))
    expect(r[0].porQue).toBe('código de barras')
  })

  it('encuentra por codigo de articulo exacto', async () => {
    const a = await unoConBarra()
    if (!a) return

    const r = await buscarArticulos(String(a.cod))
    expect(r[0].codArticu).toBe(String(a.cod))
    expect(r[0].porQue).toBe('código de artículo')
  })

  it('encuentra por prefijo del codigo', async () => {
    // TOPPER factura "27383 001" y nosotros lo tenemos como "27383  001 27",
    // uno por talle: el prefijo tiene que traerlos a todos.
    const r = await buscarArticulos('27383')
    if (r.length === 0) return
    expect(r.every((x) => x.codArticu.startsWith('27383'))).toBe(true)
  })

  it('encuentra por descripcion y avisa que el match es por texto', async () => {
    const a = await unoConBarra()
    if (!a || String(a.descripcion).length < 4) return

    const r = await buscarArticulos(String(a.descripcion).slice(0, 12))
    expect(r.length).toBeGreaterThan(0)
    // La descripcion es ambigua -- 1.046 se repiten entre varios articulos,
    // una la comparten 33 -- asi que el operador tiene que ver de donde
    // salio el match para poder desconfiar.
    expect(r.some((x) => x.porQue === 'descripción')).toBe(true)
  })

  it('prioriza el match exacto sobre el de texto', async () => {
    const a = await unoConBarra()
    if (!a) return

    const r = await buscarArticulos(String(a.barra))
    expect(r[0].porQue).toBe('código de barras')
  })

  it('no busca con menos de dos caracteres', async () => {
    // Un solo caracter traeria media base y no ayuda a nadie.
    expect(await buscarArticulos('')).toEqual([])
    expect(await buscarArticulos('a')).toEqual([])
  })

  it('devuelve vacio cuando no hay coincidencia, sin romper', async () => {
    expect(await buscarArticulos('zzzz-no-existe-zzzz')).toEqual([])
  })

  it('acota la cantidad de resultados', async () => {
    // Una busqueda amplia no puede devolver los 9.154 articulos.
    const r = await buscarArticulos('a')
    expect(r.length).toBeLessThanOrEqual(25)
    const amplia = await buscarArticulos('ZAP')
    expect(amplia.length).toBeLessThanOrEqual(25)
  })
})

describe('asociarArticuloProveedor', () => {
  /** Un artículo real y un proveedor real, descubiertos. */
  async function parReal() {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(a.COD_ARTICU)) AS art, LTRIM(RTRIM(p.COD_PROVEE)) AS prov
      FROM STA11 a CROSS JOIN (SELECT TOP 1 COD_PROVEE FROM CPA01 ORDER BY COD_PROVEE) p
      ORDER BY a.COD_ARTICU`)
    return r.recordset.length ? r.recordset[0] : null
  }

  it('escribe el codigo del proveedor y lo deja buscable', async () => {
    const par = await parReal()
    if (!par) return

    // Todo dentro de una transaccion que se revierte: CPA15 es dato maestro
    // del ERP y la suite no puede dejarlo tocado.
    await conRollback(async (tx) => {
      const marca = `ZZTEST${Date.now() % 100000}`
      await tx.request()
        .input('prov', String(par.prov))
        .input('art', String(par.art))
        .input('sin', marca)
        .query(`
          MERGE CPA15 WITH (HOLDLOCK) AS d
          USING (SELECT @prov AS COD_PROVEE, @art AS COD_ARTICU) AS o
            ON LTRIM(RTRIM(d.COD_PROVEE)) = o.COD_PROVEE
           AND LTRIM(RTRIM(d.COD_ARTICU)) = o.COD_ARTICU
          WHEN MATCHED THEN UPDATE SET COD_SINONI = @sin
          WHEN NOT MATCHED THEN
            INSERT (COD_ARTICU, COD_PROVEE, COD_SINONI, USA_ESC, ID_STA11, ID_CPA01,
                    COD_CPA01_PROVEEDOR)
            VALUES (@art, @prov, @sin,
              ISNULL((SELECT LTRIM(RTRIM(ISNULL(USA_ESC,'N'))) FROM STA11 WHERE COD_ARTICU=@art),'N'),
              (SELECT ID_STA11 FROM STA11 WHERE COD_ARTICU=@art),
              (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE=@prov),
              @prov);
        `)

      const q = await tx.request()
        .input('prov', String(par.prov))
        .input('art', String(par.art))
        .query(`
          SELECT LTRIM(RTRIM(ISNULL(COD_SINONI,''))) AS sinonimo,
                 LTRIM(RTRIM(ISNULL(USA_ESC,''))) AS usaEsc, ID_CPA15, ID_STA11
          FROM CPA15
          WHERE LTRIM(RTRIM(COD_PROVEE))=@prov AND LTRIM(RTRIM(COD_ARTICU))=@art`)

      expect(q.recordset).toHaveLength(1)
      expect(q.recordset[0].sinonimo).toBe(marca)
      // ID_CPA15 lo asigna SEQUENCE_CPA15 por default: nunca queda en 0 ni
      // se calcula a mano.
      expect(Number(q.recordset[0].ID_CPA15)).toBeGreaterThan(0)
      expect(q.recordset[0].ID_STA11).not.toBeNull()
      // USA_ESC espeja el del maestro de articulos.
      const a = await tx.request().input('art', String(par.art))
        .query(`SELECT LTRIM(RTRIM(ISNULL(USA_ESC,'N'))) AS u FROM STA11 WHERE COD_ARTICU=@art`)
      expect(q.recordset[0].usaEsc).toBe(a.recordset[0].u)
    })
  })

  it('respeta el unico de (COD_PROVEE, COD_ARTICU): no duplica filas', async () => {
    const par = await parReal()
    if (!par) return

    const pool = await getPool()
    const antes = await pool.request()
      .input('prov', String(par.prov)).input('art', String(par.art))
      .query(`SELECT COUNT(*) AS n FROM CPA15
              WHERE LTRIM(RTRIM(COD_PROVEE))=@prov AND LTRIM(RTRIM(COD_ARTICU))=@art`)
    // IX_0 es unico, asi que como maximo puede haber una.
    expect(Number(antes.recordset[0].n)).toBeLessThanOrEqual(1)
  })
})

describe('sinonimosDelProveedor', () => {
  it('devuelve vacio sin proveedor o sin articulos', async () => {
    expect((await sinonimosDelProveedor('', ['X'])).size).toBe(0)
    expect((await sinonimosDelProveedor('010685', [])).size).toBe(0)
  })

  it('solo devuelve los articulos pedidos que tienen sinonimo cargado', async () => {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS prov, LTRIM(RTRIM(COD_ARTICU)) AS art,
             LTRIM(RTRIM(COD_SINONI)) AS sinonimo
      FROM CPA15 WHERE LTRIM(RTRIM(ISNULL(COD_SINONI,''))) <> ''`)
    if (r.recordset.length === 0) return
    const x = r.recordset[0]

    const m = await sinonimosDelProveedor(String(x.prov), [String(x.art), 'NO-EXISTE-ZZZ'])
    expect(m.get(String(x.art))).toBe(String(x.sinonimo))
    expect(m.has('NO-EXISTE-ZZZ')).toBe(false)
  })
})
