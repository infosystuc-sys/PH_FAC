import { describe, it, expect, afterAll } from 'vitest'
import { cerrarPool, getPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import {
  buscarConceptoProveedor,
  buscarConceptoTarjeta,
  conceptoDelComprobante,
  listarConceptos,
  COD_CONCEPTO_TARJETA, } from '@/server/tango/conceptos'

afterAll(async () => {
  await cerrarPool()
})

describe('buscarConceptoProveedor', () => {
  it('encuentra el concepto real de un proveedor cargado (010151, AMX/Claro)', async () => {
    const r = await buscarConceptoProveedor('010151')
    expect(r).not.toBeNull()
    expect(r!.codConcepto).toBe('712')
    expect(r!.descripcion).toBe('TELEFONOS LOCALES')
  })

  it('devuelve null si el proveedor no tiene concepto configurado', async () => {
    const r = await buscarConceptoProveedor('999999')
    expect(r).toBeNull()
  })
})

describe('buscarConceptoTarjeta', () => {
  it('encuentra el concepto fijo de comisiones de tarjeta en CPA45', async () => {
    // Si esto falla, el registro de toda liquidacion de tarjeta va a
    // explotar contra un COD_CONCEP que no existe: el INSERT a CPA47
    // apunta a este codigo.
    const r = await buscarConceptoTarjeta()
    expect(r).not.toBeNull()
    expect(r!.codConcepto).toBe(COD_CONCEPTO_TARJETA)
    expect(r!.descripcion).toMatch(/comision/i)
  })

  it('lee la descripcion de Tango en vez de tenerla hardcodeada', async () => {
    // Si la renombran en Tango, la pantalla tiene que decir lo que dice
    // Tango. Se verifica contra el maestro, no contra un literal.
    const r = await buscarConceptoTarjeta()
    const pool = await getPool()
    const q = await pool.request().input('c', COD_CONCEPTO_TARJETA).query(
      `SELECT LTRIM(RTRIM(ISNULL(DESC_CONCE,''))) AS d FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @c`,
    )
    expect(r!.descripcion).toBe(String(q.recordset[0].d))
  })
})

describe('listarConceptos', () => {
  it('trae el maestro completo con codigo y descripcion', async () => {
    const r = await listarConceptos()
    expect(r.length).toBeGreaterThan(0)
    // Mismo concepto real que usan los tests de arriba: si aparece con la
    // misma descripcion, el mapeo de columnas es correcto.
    const telefonos = r.find((c) => c.codConcepto === '712')
    expect(telefonos?.descripcion).toBe('TELEFONOS LOCALES')
  })

  it('no repite codigos', async () => {
    const r = await listarConceptos()
    expect(new Set(r.map((c) => c.codConcepto)).size).toBe(r.length)
  })

  it('viene ordenado por descripcion', async () => {
    const r = await listarConceptos()
    const descripciones = r.map((c) => c.descripcion)
    expect(descripciones).toEqual([...descripciones].sort((a, b) => a.localeCompare(b)))
  })
})

describe('asignarConceptoProveedor (MERGE verificado contra la base real)', () => {
  // asignarConceptoProveedor escribe con getPool() directo, sin executor
  // inyectable -- mismo motivo que asociarArticuloProveedor en
  // articulos.test.ts: es una escritura sobre dato maestro del ERP, y la
  // suite no puede dejarla tocada. Se replica el MERGE dentro de
  // conRollback para probarlo contra datos reales sin comitear nada.
  async function proveedorSinConcepto() {
    const pool = await getPool()
    const r = await pool.request().query(`
      SELECT TOP 1 LTRIM(RTRIM(p.COD_PROVEE)) AS prov
      FROM CPA01 p
      LEFT JOIN CPA_CONCEPTOS_PROVEEDOR cp ON LTRIM(RTRIM(cp.COD_PROVEE)) = LTRIM(RTRIM(p.COD_PROVEE))
      WHERE cp.COD_PROVEE IS NULL
      ORDER BY p.COD_PROVEE
    `)
    return r.recordset.length ? String(r.recordset[0].prov) : null
  }

  async function merge(tx: import('mssql').Transaction, prov: string, concepto: string) {
    await tx.request()
      .input('prov', prov)
      .input('concepto', concepto)
      .query(`
        MERGE CPA_CONCEPTOS_PROVEEDOR WITH (HOLDLOCK) AS destino
        USING (SELECT @prov AS COD_PROVEE) AS origen
          ON LTRIM(RTRIM(destino.COD_PROVEE)) = origen.COD_PROVEE
        WHEN MATCHED THEN
          UPDATE SET COD_CONCEPT = @concepto,
                     ID_CPA45 = (SELECT ID_CPA45 FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @concepto)
        WHEN NOT MATCHED THEN
          INSERT (COD_PROVEE, COD_CONCEPT, ID_CPA45, ID_CPA01)
          VALUES (
            @prov, @concepto,
            (SELECT ID_CPA45 FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @concepto),
            (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE = @prov)
          );
      `)
  }

  it('inserta la relacion con los IDs reales resueltos', async () => {
    const prov = await proveedorSinConcepto()
    if (!prov) return

    await conRollback(async (tx) => {
      await merge(tx, prov, '712')

      const q = await tx.request().input('prov', prov).query(`
        SELECT LTRIM(RTRIM(COD_CONCEPT)) AS concepto, ID_CPA45, ID_CPA01
        FROM CPA_CONCEPTOS_PROVEEDOR WHERE LTRIM(RTRIM(COD_PROVEE)) = @prov
      `)
      expect(q.recordset).toHaveLength(1)
      expect(q.recordset[0].concepto).toBe('712')
      expect(Number(q.recordset[0].ID_CPA45)).toBeGreaterThan(0)
      expect(Number(q.recordset[0].ID_CPA01)).toBeGreaterThan(0)
    })
  })

  it('un segundo concepto reemplaza al primero en vez de agregar una fila', async () => {
    const prov = await proveedorSinConcepto()
    if (!prov) return

    await conRollback(async (tx) => {
      await merge(tx, prov, '712')
      await merge(tx, prov, '001')

      const q = await tx.request().input('prov', prov).query(`
        SELECT LTRIM(RTRIM(COD_CONCEPT)) AS concepto
        FROM CPA_CONCEPTOS_PROVEEDOR WHERE LTRIM(RTRIM(COD_PROVEE)) = @prov
      `)
      expect(q.recordset).toHaveLength(1)
      expect(q.recordset[0].concepto).toBe('001')
    })
  })
})

describe('conceptoDelComprobante', () => {
  it('en tarjeta devuelve el fijo, sin mirar el proveedor', async () => {
    const conProv = await conceptoDelComprobante('tarjeta', '010151')
    const sinProv = await conceptoDelComprobante('tarjeta', null)
    expect(conProv?.codConcepto).toBe(COD_CONCEPTO_TARJETA)
    // El proveedor de una liquidacion es la tarjeta o el banco, y su ficha
    // puede tener otro concepto o ninguno: no tiene que influir.
    expect(sinProv?.codConcepto).toBe(COD_CONCEPTO_TARJETA)
  })

  it('en conceptos devuelve el de la ficha del proveedor', async () => {
    const r = await conceptoDelComprobante('conceptos', '010151')
    expect(r?.codConcepto).toBe('712')
  })

  it('en articulos no hay concepto: se imputa por renglon', async () => {
    expect(await conceptoDelComprobante('articulos', '010151')).toBeNull()
  })
})

describe('conceptoDelComprobante con un concepto elegido para el comprobante', () => {
  // Pedido del usuario, 2026-09-17: cambiar el concepto de UNA factura sin
  // tocar el que tiene guardado el proveedor. Solo lee: no escribe en
  // CPA_CONCEPTOS_PROVEEDOR ni en ningun lado.
  it('el elegido gana sobre la ficha del proveedor, y la ficha no cambia', async () => {
    const ficha = await buscarConceptoProveedor('010151')
    expect(ficha).not.toBeNull()
    const otro = (await listarConceptos()).find((c) => c.codConcepto !== ficha!.codConcepto)
    expect(otro).toBeDefined()

    const resuelto = await conceptoDelComprobante('conceptos', '010151', otro!.codConcepto)
    expect(resuelto?.codConcepto).toBe(otro!.codConcepto)
    expect(resuelto?.descripcion).toBe(otro!.descripcion)

    // La ficha sigue diciendo lo mismo.
    expect((await buscarConceptoProveedor('010151'))?.codConcepto).toBe(ficha!.codConcepto)
  })

  it('vacio o ausente, vale el de la ficha', async () => {
    const ficha = await buscarConceptoProveedor('010151')
    expect((await conceptoDelComprobante('conceptos', '010151', ''))?.codConcepto).toBe(ficha!.codConcepto)
    expect((await conceptoDelComprobante('conceptos', '010151', null))?.codConcepto).toBe(ficha!.codConcepto)
    expect((await conceptoDelComprobante('conceptos', '010151'))?.codConcepto).toBe(ficha!.codConcepto)
  })

  it('un codigo que no existe en CPA45 resuelve a null, no a la ficha', async () => {
    // Si el operador eligio algo que ya no esta en el maestro, la validacion
    // tiene que decirlo, no caerse en silencio al de la ficha.
    expect(await conceptoDelComprobante('conceptos', '010151', 'ZZZ')).toBeNull()
  })

  it('en tarjeta el elegido no aplica: el concepto es fijo', async () => {
    const r = await conceptoDelComprobante('tarjeta', '010151', '712')
    expect(r?.codConcepto).toBe(COD_CONCEPTO_TARJETA)
  })
})
