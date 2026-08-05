import { describe, it, expect, afterAll } from 'vitest'
import { listarAlicuotasIva, listarCodigosImpuesto } from '@/server/tango/impuestos'
import { getPool, cerrarPool } from '@/server/db/pool'

afterAll(async () => {
  await cerrarPool()
})

describe('listarAlicuotasIva', () => {
  it('trae las alicuotas de IVA de la base', async () => {
    const r = await listarAlicuotasIva()
    expect(r.length).toBeGreaterThan(0)
  })

  it('incluye la tasa general del 21%', async () => {
    const r = await listarAlicuotasIva()
    expect(r.some((a) => a.porcentaje === 21 && !a.percepcion)).toBe(true)
  })

  it('no repite codigos', async () => {
    const codigos = (await listarAlicuotasIva()).map((a) => a.codigo)
    expect(new Set(codigos).size).toBe(codigos.length)
  })

  it('cubre todas las alicuotas que las facturas usan en su cabecera', async () => {
    // CPA04.COD_IVA1 es el primer slot de IVA de la cabecera. Todo codigo que
    // aparezca ahi en una factura tiene que estar en la lista, o la pantalla
    // de revision no va a poder mostrar comprobantes historicos. El 0 se
    // excluye: es "sin alicuota", no un codigo.
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT DISTINCT COD_IVA1 AS cod FROM CPA04
      WHERE T_COMP = 'FAC' AND COD_IVA1 <> 0
    `)
    const usados = r.recordset.map((x) => Number(x.cod))
    expect(usados.length).toBeGreaterThan(0)

    const disponibles = new Set((await listarAlicuotasIva()).map((a) => a.codigo))
    expect(usados.filter((c) => !disponibles.has(c))).toEqual([])
  })
})

describe('listarCodigosImpuesto', () => {
  it('trae los codigos de impuesto de la base', async () => {
    const r = await listarCodigosImpuesto()
    expect(r.length).toBeGreaterThan(0)
  })

  it('no repite codigos', async () => {
    const codigos = (await listarCodigosImpuesto()).map((c) => c.codigo)
    expect(new Set(codigos).size).toBe(codigos.length)
  })

  it('ninguno es una alicuota de IVA', async () => {
    const iva = new Set((await listarAlicuotasIva()).map((a) => a.codigo))
    const impuestos = await listarCodigosImpuesto()
    expect(impuestos.filter((c) => iva.has(c.codigo))).toEqual([])
    expect(impuestos.every((c) => c.tipo !== 'IV')).toBe(true)
  })

  it('cubre todos los codigos que CPA18 usa realmente', async () => {
    // Esta es la prueba que sostiene la particion por TIPO_ALI. CPA18 es la
    // tabla de valores de impuestos de cada comprobante; si un codigo que
    // aparece ahi no estuviera en la lista, la fase 4 no podria replicar un
    // comprobante como los que ya existen.
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT DISTINCT TRY_CAST(COD_IMPUES AS INT) AS cod FROM CPA18
      WHERE TRY_CAST(COD_IMPUES AS INT) IS NOT NULL
    `)
    const usados = r.recordset.map((x) => Number(x.cod))
    expect(usados.length).toBeGreaterThan(0)

    const disponibles = new Set((await listarCodigosImpuesto()).map((c) => c.codigo))
    expect(usados.filter((c) => !disponibles.has(c))).toEqual([])
  })

  it('trae la percepcion de IIBB y el impuesto interno de la factura de referencia', async () => {
    // FAC A0011800063576 genero dos filas en CPA18: COD_IMPUES 60 y 40.
    const porCodigo = new Map((await listarCodigosImpuesto()).map((c) => [c.codigo, c]))
    expect(porCodigo.get(60)?.tipo).toBe('IB')
    expect(porCodigo.get(40)?.tipo).toBe('II')
  })
})
