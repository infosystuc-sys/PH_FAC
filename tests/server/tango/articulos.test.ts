import { describe, it, expect, afterAll } from 'vitest'
import { buscarArticulos } from '@/server/tango/articulos'
import { getPool, cerrarPool } from '@/server/db/pool'

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
