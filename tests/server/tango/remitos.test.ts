import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  buscarRemitosPendientes,
  buscarRemitoPorNumero,
  normalizarNumeroRemito,
} from '@/server/tango/remitos'
import { getPool, cerrarPool } from '@/server/db/pool'

// Un proveedor que hoy tiene remitos pendientes. Se descubre en vez de
// hardcodearse: los 13 remitos pendientes de hoy se van a facturar y la
// suite no puede depender de que sigan ahi.
let provConPendientes: string

beforeAll(async () => {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(h.COD_PRO_CL)) AS cod
    FROM STA14 h
    JOIN STA20 r ON r.TCOMP_IN_S = h.TCOMP_IN_S AND r.NCOMP_IN_S = h.NCOMP_IN_S
    WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P' AND r.CANT_PEND > 0
    GROUP BY h.COD_PRO_CL
    ORDER BY COUNT(DISTINCT h.NCOMP_IN_S) DESC, h.COD_PRO_CL
  `)
  provConPendientes = r.recordset.length ? String(r.recordset[0].cod) : ''
})

afterAll(async () => {
  await cerrarPool()
})

describe('buscarRemitosPendientes', () => {
  it('encuentra los remitos de un proveedor que tiene pendientes', async () => {
    if (!provConPendientes) return // No quedan remitos pendientes en la base.
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.length).toBeGreaterThan(0)
  })

  it('todos los remitos son del proveedor pedido', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.every((x) => x.codProvee === provConPendientes)).toBe(true)
  })

  it('ningun remito viene sin renglones', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    expect(r.every((x) => x.renglones.length > 0)).toBe(true)
  })

  it('todo renglon devuelto tiene saldo por facturar', async () => {
    if (!provConPendientes) return
    const r = await buscarRemitosPendientes(provConPendientes)
    const renglones = r.flatMap((x) => x.renglones)
    expect(renglones.length).toBeGreaterThan(0)
    expect(renglones.every((l) => l.cantidadPendiente > 0)).toBe(true)
  })

  it('no repite el mismo remito en dos grupos', async () => {
    if (!provConPendientes) return
    const nums = (await buscarRemitosPendientes(provConPendientes)).map((x) => x.numeroInterno)
    expect(new Set(nums).size).toBe(nums.length)
  })

  it('trae la descripcion del articulo, no solo el codigo', async () => {
    if (!provConPendientes) return
    const renglones = (await buscarRemitosPendientes(provConPendientes)).flatMap(
      (x) => x.renglones,
    )
    expect(renglones.every((l) => l.codArticulo !== '')).toBe(true)
    // STA11 cubre todos los articulos de los renglones de RP (verificado).
    expect(renglones.some((l) => l.descripcion !== null && l.descripcion !== '')).toBe(true)
  })

  it('ordena los renglones por numero dentro de cada remito', async () => {
    if (!provConPendientes) return
    for (const rem of await buscarRemitosPendientes(provConPendientes)) {
      const ns = rem.renglones.map((l) => l.nRenglon)
      expect(ns).toEqual([...ns].sort((a, b) => a - b))
    }
  })

  it('coincide con lo que dice la base para ese proveedor', async () => {
    if (!provConPendientes) return
    const pool = await getPool()
    const r = await pool
      .request()
      .input('prov', provConPendientes)
      .query(`
        SELECT COUNT(DISTINCT h.NCOMP_IN_S) AS remitos, COUNT(*) AS renglones
        FROM STA14 h
        JOIN STA20 l ON l.TCOMP_IN_S = h.TCOMP_IN_S AND l.NCOMP_IN_S = h.NCOMP_IN_S
        WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P'
          AND l.CANT_PEND > 0 AND h.COD_PRO_CL = @prov
      `)
    const esperado = r.recordset[0]

    const devuelto = await buscarRemitosPendientes(provConPendientes)
    expect(devuelto.length).toBe(Number(esperado.remitos))
    expect(devuelto.flatMap((x) => x.renglones).length).toBe(Number(esperado.renglones))
  })

  it('devuelve vacio para un proveedor que no existe', async () => {
    const r = await buscarRemitosPendientes('999999')
    expect(r).toEqual([])
  })

  it('devuelve vacio con codigo vacio, sin pegarle a la base', async () => {
    const r = await buscarRemitosPendientes('   ')
    expect(r).toEqual([])
  })

  it('no devuelve remitos ya facturados', async () => {
    // Todo remito devuelto tiene que estar en estado 'P' en STA14.
    if (!provConPendientes) return
    const devuelto = await buscarRemitosPendientes(provConPendientes)
    if (!devuelto.length) return

    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT LTRIM(RTRIM(NCOMP_IN_S)) AS num FROM STA14
      WHERE TCOMP_IN_S = 'RP' AND ESTADO_MOV = 'F'
    `)
    const facturados = new Set(r.recordset.map((x) => String(x.num)))
    expect(devuelto.filter((x) => facturados.has(x.numeroInterno))).toEqual([])
  })
})

describe('normalizarNumeroRemito', () => {
  // Tango guarda el numero como R + punto de venta (5) + numero (8) en
  // CHAR(14). El proveedor lo imprime como se le ocurre, asi que se trabaja
  // solo con los digitos y se rearma esa forma.
  it('arma la forma de Tango desde lo que puede venir impreso', () => {
    for (const impreso of [
      '0001-00029869',
      'R 0001-00029869',
      '00001-00029869',
      'Remito 0001 00029869',
      '000100029869',
    ]) {
      expect(normalizarNumeroRemito(impreso), impreso).toEqual({
        ptovta: '00001',
        numero: '00029869',
      })
    }
  })

  it('rellena el punto de venta con ceros a la izquierda', () => {
    expect(normalizarNumeroRemito('1-29869')).toEqual({ ptovta: '00001', numero: '00029869' })
  })

  it('devuelve null cuando no hay digitos suficientes', () => {
    // Mejor no buscar que buscar cualquier cosa: un numero a medias
    // matchearia el remito de otra compra.
    expect(normalizarNumeroRemito('')).toBeNull()
    expect(normalizarNumeroRemito(null)).toBeNull()
    expect(normalizarNumeroRemito('sin numero')).toBeNull()
    expect(normalizarNumeroRemito('1234567')).toBeNull()
  })

  it('devuelve null si el punto de venta no entra en 5 digitos', () => {
    expect(normalizarNumeroRemito('1234567-00029869')).toBeNull()
  })
})

describe('buscarRemitoPorNumero', () => {
  /** Un remito con saldo, descubierto y no hardcodeado (se van facturando). */
  async function unoPendiente() {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(h.N_COMP)) AS nComp, LTRIM(RTRIM(h.COD_PRO_CL)) AS prov,
             LTRIM(RTRIM(h.NCOMP_IN_S)) AS interno
      FROM STA14 h
      JOIN STA20 r ON r.TCOMP_IN_S = h.TCOMP_IN_S AND r.NCOMP_IN_S = h.NCOMP_IN_S
      WHERE h.TCOMP_IN_S = 'RP' AND h.ESTADO_MOV = 'P' AND r.CANT_PEND > 0
      GROUP BY h.N_COMP, h.COD_PRO_CL, h.NCOMP_IN_S
      ORDER BY h.NCOMP_IN_S DESC
    `)
    return r.recordset.length ? r.recordset[0] : null
  }

  it('encuentra el remito por su numero impreso y trae los renglones pendientes', async () => {
    const p = await unoPendiente()
    if (!p) return

    // Se le pasa como lo imprimiria un proveedor, con guion y sin la R.
    const impreso = `${String(p.nComp).slice(1, 6)}-${String(p.nComp).slice(6)}`
    const r = await buscarRemitoPorNumero(String(p.prov), impreso)

    expect(r.estado).toBe('encontrado')
    if (r.estado !== 'encontrado') return
    expect(r.remito.numeroInterno).toBe(String(p.interno))
    expect(r.remito.renglones.length).toBeGreaterThan(0)
    for (const x of r.remito.renglones) expect(x.cantidadPendiente).toBeGreaterThan(0)
  })

  it('distingue el remito ya facturado del que no existe', async () => {
    const pool = await getPool()
    const f = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(N_COMP)) AS nComp, LTRIM(RTRIM(COD_PRO_CL)) AS prov
      FROM STA14 WHERE TCOMP_IN_S = 'RP' AND ESTADO_MOV = 'F' ORDER BY NCOMP_IN_S DESC
    `)
    if (f.recordset.length > 0) {
      const x = f.recordset[0]
      const r = await buscarRemitoPorNumero(String(x.prov), String(x.nComp))
      // Existe pero sin saldo: proponer sus articulos duplicaria una compra.
      expect(r.estado).toBe('sin-saldo')
    }

    const p = await unoPendiente()
    if (p) {
      const inventado = await buscarRemitoPorNumero(String(p.prov), '99999-99999999')
      expect(inventado.estado).toBe('no-existe')
    }
  })

  it('encuentra el remito aunque el primer digito del numero no coincida', async () => {
    // Caso real: proveedor 010685 (TOPPER ARGENTINA S.A.). El PDF imprime
    // "Remito/Factura Nº: 5026-00530766", pero Tango lo tiene guardado
    // como R0502610530766 -- identico salvo el primer digito del numero.
    // Este remito ya esta facturado por completo (ESTADO_MOV = 'F'): existe
    // pero no tiene renglones pendientes, asi que el estado esperado es
    // "sin-saldo", no "no-existe" como daba antes del comodin.
    const r = await buscarRemitoPorNumero('010685', '5026-00530766')
    expect(r.estado).toBe('sin-saldo')
  })

  it('no cruza remitos entre proveedores distintos', async () => {
    // El punto de venta es del proveedor, no nuestro: el mismo numero
    // impreso puede repetirse entre proveedores.
    const p = await unoPendiente()
    if (!p) return

    const pool = await getPool()
    const otro = await pool.request().input('prov', String(p.prov)).query(`
      SELECT TOP 1 LTRIM(RTRIM(COD_PROVEE)) AS cod FROM CPA01
      WHERE LTRIM(RTRIM(COD_PROVEE)) <> @prov ORDER BY COD_PROVEE
    `)
    if (otro.recordset.length === 0) return

    const r = await buscarRemitoPorNumero(String(otro.recordset[0].cod), String(p.nComp))
    expect(r.estado).not.toBe('encontrado')
  })
})
