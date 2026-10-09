import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { conRollback } from '@/server/db/tx'
import { getPool, cerrarPool } from '@/server/db/pool'
import { importarArcaEn, importacionVigenteEn, conciliarEn } from '@/server/app/arca'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Un comprobante REAL de Tango, para que la conciliacion tenga contra que
 * cruzar. Se lee de la base en vez de inventarse: lo que se prueba es
 * justamente que el cruce funcione con los datos que hay.
 */
async function unComprobanteDeTango() {
  const pool = await getPool()
  const r = await pool.request().query<Record<string, unknown>>(`
    SELECT TOP 1
      c.N_COMP AS nComp, LTRIM(RTRIM(c.T_COMP)) AS tipo,
      REPLACE(REPLACE(ISNULL(p.N_CUIT,''), '-', ''), ' ', '') AS cuit,
      c.FECHA_EMIS AS fecha, ISNULL(c.IMPORTE_TO, 0) AS total
    FROM CPA04 c JOIN CPA01 p ON p.COD_PROVEE = c.COD_PROVEE
    WHERE LTRIM(RTRIM(c.T_COMP)) = 'FAC'
      AND LEN(REPLACE(REPLACE(ISNULL(p.N_CUIT,''), '-', ''), ' ', '')) = 11
      AND LEFT(c.N_COMP, 1) = 'A'
      AND ISNULL(c.IMPORTE_TO, 0) > 0
    ORDER BY c.FECHA_EMIS DESC`)
  const x = r.recordset[0]
  if (!x) return null
  const nComp = String(x.nComp).trim()
  return {
    nComp,
    puntoVenta: Number(nComp.slice(-13, -8)),
    numero: Number(nComp.slice(-8)),
    cuit: String(x.cuit),
    fecha: new Date(x.fecha as string),
    total: Number(x.total),
  }
}

function csv(filas: string[]): string {
  const cab =
    'Fecha;Tipo;Punto de Venta;Número Desde;Número Hasta;Cód. Autorización;' +
    'Tipo Doc. Emisor;Nro. Doc. Emisor;Denominación Emisor;Imp. Neto Gravado;IVA;Imp. Total'
  return [cab, ...filas].join('\n')
}

function fila(o: {
  fecha: string
  tipo: number
  pv: number
  nro: number
  cuit: string
  total: number
}): string {
  return [
    o.fecha,
    String(o.tipo),
    String(o.pv),
    String(o.nro),
    String(o.nro),
    '75000000000001',
    '80',
    o.cuit,
    'PROVEEDOR DE PRUEBA S.A.',
    '0,00',
    '0,00',
    o.total.toFixed(2).replace('.', ','),
  ].join(';')
}

describe('importarArcaEn', () => {
  it('lee el archivo y deja una importacion con su periodo', async () => {
    await conRollback(async (tx) => {
      const r = await importarArcaEn(
        tx,
        'mis-comprobantes.csv',
        csv([
          fila({ fecha: '01/09/2026', tipo: 1, pv: 1, nro: 1, cuit: '30500525327', total: 100 }),
          fila({ fecha: '30/09/2026', tipo: 1, pv: 1, nro: 2, cuit: '30500525327', total: 200 }),
        ]),
      )
      expect(r.filas).toBe(2)
      expect(r.ignoradas).toBe(0)
      // El periodo sale de las filas, no se le pide al operador.
      expect(r.desde).toEqual(new Date(2026, 8, 1))
      expect(r.hasta).toEqual(new Date(2026, 8, 30))

      const vigente = await importacionVigenteEn(tx)
      expect(vigente?.archivoNombre).toBe('mis-comprobantes.csv')
      expect(vigente?.filas).toBe(2)
    })
  })

  it('una importacion nueva REEMPLAZA a la anterior', async () => {
    // Volver a subir es la forma normal de corregir: acumular dejaria el
    // mismo comprobante informado dos veces.
    await conRollback(async (tx) => {
      await importarArcaEn(tx, 'vieja.csv', csv([
        fila({ fecha: '01/09/2026', tipo: 1, pv: 1, nro: 1, cuit: '30500525327', total: 100 }),
      ]))
      await importarArcaEn(tx, 'nueva.csv', csv([
        fila({ fecha: '01/10/2026', tipo: 1, pv: 1, nro: 9, cuit: '30500525327', total: 500 }),
      ]))

      const vigente = await importacionVigenteEn(tx)
      expect(vigente?.archivoNombre).toBe('nueva.csv')
      const n = await tx.request().query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM PHF_ARCA_COMPROBANTE',
      )
      expect(n.recordset[0].n).toBe(1)
    })
  })

  it('un archivo que no es el de ARCA se rechaza con lo que encontro', async () => {
    await conRollback(async (tx) => {
      await expect(
        importarArcaEn(tx, 'otra-cosa.csv', 'Columna A;Columna B\n1;2'),
      ).rejects.toThrow(/No se reconoce el formato/)
    })
  })

  it('cuenta las filas que no se pudieron interpretar en vez de tragarlas', async () => {
    await conRollback(async (tx) => {
      const r = await importarArcaEn(
        tx,
        'con-basura.csv',
        csv([
          fila({ fecha: '01/09/2026', tipo: 1, pv: 1, nro: 1, cuit: '30500525327', total: 100 }),
          'fecha mala;1;1;2;2;x;80;30500525327;X;0,00;0,00;100,00',
          ';;;;;;;;;;;',
        ]),
      )
      expect(r.filas).toBe(1)
      expect(r.ignoradas).toBe(2)
    })
  })
})

describe('conciliarEn', () => {
  it('sin importacion no hay nada que conciliar', async () => {
    await conRollback(async (tx) => {
      await tx.request().query('DELETE FROM PHF_ARCA_IMPORTACION')
      const r = await conciliarEn(tx)
      expect(r.importacion).toBeNull()
      expect(r.filas).toEqual([])
    })
  })

  it('encuentra en Tango un comprobante real informado por ARCA', async () => {
    const t = await unComprobanteDeTango()
    if (!t) return

    await conRollback(async (tx) => {
      const dd = String(t.fecha.getDate()).padStart(2, '0')
      const mm = String(t.fecha.getMonth() + 1).padStart(2, '0')
      await importarArcaEn(
        tx,
        'real.csv',
        csv([
          fila({
            fecha: `${dd}/${mm}/${t.fecha.getFullYear()}`,
            tipo: 1,
            pv: t.puntoVenta,
            nro: t.numero,
            cuit: t.cuit,
            total: t.total,
          }),
        ]),
      )

      const r = await conciliarEn(tx)
      const suyo = r.filas.find((f) => f.arca?.numero === t.numero)
      expect(suyo?.estado).toBe('coincide')
      expect(suyo?.tango?.nComp.trim()).toBe(t.nComp)
    })
  })

  it('marca como faltante uno que ARCA informa y Tango no tiene', async () => {
    await conRollback(async (tx) => {
      await importarArcaEn(tx, 'faltante.csv', csv([
        // Un CUIT que no es de ningun proveedor y un numero altisimo.
        fila({ fecha: '15/09/2026', tipo: 1, pv: 99998, nro: 99999999, cuit: '30999999993', total: 123 }),
      ]))
      const r = await conciliarEn(tx)
      const suyo = r.filas.find((f) => f.arca?.numero === 99999999)
      expect(suyo?.estado).toBe('falta-en-tango')
    })
  })

  it('marca la diferencia de importe contra un comprobante real', async () => {
    const t = await unComprobanteDeTango()
    if (!t) return

    await conRollback(async (tx) => {
      const dd = String(t.fecha.getDate()).padStart(2, '0')
      const mm = String(t.fecha.getMonth() + 1).padStart(2, '0')
      await importarArcaEn(tx, 'difiere.csv', csv([
        fila({
          fecha: `${dd}/${mm}/${t.fecha.getFullYear()}`,
          tipo: 1,
          pv: t.puntoVenta,
          nro: t.numero,
          cuit: t.cuit,
          total: t.total + 50000,
        }),
      ]))

      const r = await conciliarEn(tx)
      const suyo = r.filas.find((f) => f.arca?.numero === t.numero)
      expect(suyo?.estado).toBe('difiere')
      expect(suyo?.diferencia).toContain('ARCA informa')
    })
  })
})
