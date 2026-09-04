import { describe, it, expect, afterAll } from 'vitest'
import {
  cargarModeloAsiento,
  cuentaDelConcepto,
  cuentasDeArticulos,
  previsualizarAsientoEn,
  escribirAsientoEn,
} from '@/server/tango/asiento'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { insertarComprobantePrueba, insertarRenglonPrueba } from '@/server/app/comprobantes'
import { guardarCampoEn } from '@/server/app/detalle'
import { terminalActual } from '@/lib/usuario'

afterAll(async () => {
  await cerrarPool()
})

describe('cargarModeloAsiento', () => {
  it('trae el modelo 1 con las cuentas reales verificadas contra la base', async () => {
    const modelo = await cargarModeloAsiento()

    expect(modelo.get('SB')).toMatchObject({
      codCuenta: '14003',
      descCuenta: 'COMPRAS - MERCADERIA',
      dh: 'D',
      reemplazaCuenta: true,
    })
    expect(modelo.get('EX')).toMatchObject({
      codCuenta: '14003',
      dh: 'D',
      reemplazaCuenta: true,
    })
    // Los codigos de IVA del modelo son los mismos codigos de CPA14 que ya
    // usa el formulario en porciva1..5 -- es el hallazgo central del spec.
    expect(modelo.get('1')).toMatchObject({ codCuenta: '13405', descCuenta: 'DGI - IVA CREDITO FISCAL', dh: 'D' })
    expect(modelo.get('4')).toMatchObject({ codCuenta: '13405', dh: 'D' })
    // Percepcion IIBB Tucuman, mismo codigo que codpercibb.
    expect(modelo.get('60')).toMatchObject({ codCuenta: '13411', descCuenta: 'PERCEPCIONES SUFRIDAS IIBB', dh: 'D' })
    // Total del comprobante: Haber, cuenta de proveedores, reemplazable
    // (el reemplazo en si no esta implementado -- ver el spec).
    expect(modelo.get('TO')).toMatchObject({
      codCuenta: '20002',
      descCuenta: 'PROVEEDORES',
      dh: 'H',
      reemplazaCuenta: true,
    })
  })

  it('no trae nada fuera del modulo CP', async () => {
    const modelo = await cargarModeloAsiento()
    // Sanity check: el modelo 1 tiene 27 renglones reales verificados el
    // 2026-08-21. Un numero muy distinto significa que cambio la
    // configuracion de Tango o el filtro de la query esta mal.
    expect(modelo.size).toBe(27)
  })
})

describe('cuentaDelConcepto', () => {
  it('resuelve la cuenta real del concepto 712 (TELEFONOS LOCALES)', async () => {
    const cuenta = await cuentaDelConcepto('712')
    expect(cuenta).toEqual({ idCuenta: 382, codCuenta: '51460', descCuenta: 'TELEFONOS LOCALES' })
  })

  it('devuelve null para un concepto que no existe', async () => {
    const cuenta = await cuentaDelConcepto('999')
    expect(cuenta).toBeNull()
  })
})

describe('cuentasDeArticulos', () => {
  it('resuelve la cuenta de compras real de un articulo conocido', async () => {
    const cuentas = await cuentasDeArticulos(['106817'])
    expect(cuentas.get('106817')).toEqual({ idCuenta: 120, codCuenta: '14003', descCuenta: 'COMPRAS - MERCADERIA' })
  })

  it('no incluye un codigo que no tiene ARTICULO_CUENTA', async () => {
    const cuentas = await cuentasDeArticulos(['no-existe-123'])
    expect(cuentas.has('no-existe-123')).toBe(false)
  })

  it('devuelve un mapa vacio para una lista vacia', async () => {
    const cuentas = await cuentasDeArticulos([])
    expect(cuentas.size).toBe(0)
  })
})

describe('previsualizarAsientoEn', () => {
  it('factura de conceptos: Subtotal gravado va a la cuenta del concepto', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'TELEFONOS LOCALES')
      expect(sb).toMatchObject({ codCuenta: '51460', debe: 10000, haber: 0 })

      const iva = asiento.lineas.find((l) => l.codCuenta === '13405')
      expect(iva).toMatchObject({ debe: 2100, haber: 0 })

      const total = asiento.lineas.find((l) => l.codCuenta === '20002')
      expect(total).toMatchObject({ debe: 0, haber: 12100 })

      expect(asiento.totalDebe).toBe(12100)
      expect(asiento.totalHaber).toBe(12100)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('la leyenda del operador reemplaza la leyenda de cada renglon', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')
      await guardarCampoEn(tx, id, 'leyendaAsiento', 'Pago adelantado agosto')

      const asiento = await previsualizarAsientoEn(tx, id)

      expect(asiento.lineas).toHaveLength(3)
      // Todas las lineas dicen lo mismo: la del modelo ("Subtotal gravado",
      // "IVA 21%"...) queda reemplazada, no concatenada.
      for (const l of asiento.lineas) {
        expect(l.leyenda).toBe('Pago adelantado agosto')
      }
    })
  })

  it('sin leyenda del operador, las lineas quedan igual que antes', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')

      const asiento = await previsualizarAsientoEn(tx, id)
      const sb = asiento.lineas.find((l) => l.codCuenta === '51460')
      expect(sb!.leyenda).toBe('Subtotal gravado')
    })
  })

  it('la leyenda del operador se trunca a 100 caracteres, igual que va a quedar grabada', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')
      await guardarCampoEn(tx, id, 'leyendaAsiento', 'X'.repeat(200))

      const asiento = await previsualizarAsientoEn(tx, id)
      for (const l of asiento.lineas) {
        expect(l.leyenda.length).toBeLessThanOrEqual(100)
      }
    })
  })

  it('factura de articulos: Subtotal gravado va a la cuenta del articulo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '80745,57')
      await guardarCampoEn(tx, id, 'total', '80745,57')
      await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Microondas', cantidad: '1',
        // PRECIO_UNITARIO_IA es DECIMAL(19,4) en PHF_RENGLON (scripts/migrate.ts) --
        // el brief traia '80745,57' (coma) aca, que no convierte implicitamente a
        // numeric. El resto del codebase pasa este campo con punto decimal
        // (ver tests/server/app/acciones.test.ts, tests/server/tango/comprobantes.test.ts).
        precioUnitario: '80745.57', importe: '80745.57',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.descCuenta === 'COMPRAS - MERCADERIA')
      expect(sb).toMatchObject({ codCuenta: '14003', debe: 80745.57, haber: 0 })
    })
  })

  it('percepcion IIBB Tucuman va a la cuenta del modelo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1025,00')
      await guardarCampoEn(tx, id, 'percep1', 'Tucumán')
      await guardarCampoEn(tx, id, 'codpercep1', '60')
      await guardarCampoEn(tx, id, 'imppercep1', '25,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const percep = asiento.lineas.find((l) => l.codCuenta === '13411')
      expect(percep).toMatchObject({ debe: 25, haber: 0 })
    })
  })

  it('un comprobante sin campos no rompe: devuelve un asiento vacio', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const asiento = await previsualizarAsientoEn(tx, id)
      expect(asiento.lineas).toEqual([])
      expect(asiento.totalDebe).toBe(0)
      expect(asiento.totalHaber).toBe(0)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('factura de articulos con dos cuentas distintas: Subtotal gravado se prorratea, no se suma crudo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '100000,00')
      await guardarCampoEn(tx, id, 'total', '100000,00')
      await insertarRenglonPrueba(tx, id, {
        codigo: '106817', descripcion: 'Microondas', cantidad: '1',
        precioUnitario: '59999.99', importe: '59999.99',
      })
      await insertarRenglonPrueba(tx, id, {
        codigo: '474575', descripcion: 'Articulo deportivo', cantidad: '1',
        precioUnitario: '40000.02', importe: '40000.02',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const lineasSb = asiento.lineas.filter((l) => l.codCuenta === '14003' || l.codCuenta === '14007')
      expect(lineasSb).toHaveLength(2)
      // Las lineas de Subtotal gravado tienen que sumar EXACTO el neto de
      // cabecera (100000), no la suma cruda de renglones (100000.01) --
      // es justo lo que corrige el prorrateo.
      const sumaSb = lineasSb.reduce((acc, l) => acc + l.debe, 0)
      expect(Math.round(sumaSb * 100) / 100).toBe(100000)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('un articulo sin ARTICULO_CUENTA cae a la cuenta de Subtotal gravado del modelo', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'articulos')
      await guardarCampoEn(tx, id, 'neto', '5000,00')
      await guardarCampoEn(tx, id, 'total', '5000,00')
      await insertarRenglonPrueba(tx, id, {
        codigo: 'no-existe-456', descripcion: 'Articulo sin cuenta configurada', cantidad: '1',
        precioUnitario: '5000.00', importe: '5000.00',
      })

      const asiento = await previsualizarAsientoEn(tx, id)

      const sb = asiento.lineas.find((l) => l.debe === 5000)
      // 14003 es la cuenta del modelo para SB (ver el test de cargarModeloAsiento).
      expect(sb).toMatchObject({ codCuenta: '14003', debe: 5000 })
    })
  })

  it('Subtotal exento va a la misma cuenta que Subtotal gravado en conceptos', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '8000,00')
      await guardarCampoEn(tx, id, 'exento', '2000,00')
      await guardarCampoEn(tx, id, 'total', '10000,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      const lineasCuenta51460 = asiento.lineas.filter((l) => l.codCuenta === '51460')
      expect(lineasCuenta51460).toHaveLength(2)
      expect(lineasCuenta51460.map((l) => l.debe).sort((a, b) => a - b)).toEqual([2000, 8000])
    })
  })

  it('liquidacion de tarjeta: Total del comprobante es subtotal + IVA, no el importe leido', async () => {
    // El total impreso de un resumen de tarjeta sale por diferencia (saldo
    // anterior, pagos, intereses que la app no captura) -- decision del
    // usuario, 2026-08-21. Se fuerza un "total" leido bien distinto para
    // probar que se ignora.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'tarjeta')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')
      await guardarCampoEn(tx, id, 'total', '999999,99')

      const asiento = await previsualizarAsientoEn(tx, id)

      const total = asiento.lineas.find((l) => l.codCuenta === '20002')
      expect(total).toMatchObject({ debe: 0, haber: 12100 })
      expect(asiento.totalHaber).toBe(12100)
      expect(asiento.balanceado).toBe(true)
    })
  })

  it('cuenta las lineas omitidas por falta de codigo, sin bloquear', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1050,00')
      // Jurisdiccion que no matchea ninguna de JURISDICCIONES_IIBB: sin-codigo.
      await guardarCampoEn(tx, id, 'percep1', 'Jurisdiccion inventada que no existe')
      await guardarCampoEn(tx, id, 'imppercep1', '50,00')

      const asiento = await previsualizarAsientoEn(tx, id)

      expect(asiento.lineasOmitidas).toBe(1)
      expect(asiento.balanceado).toBe(false)
    })
  })
})

describe('escribirAsientoEn', () => {
  /** Un NCOMP_IN_C que no puede colisionar con ninguno real. */
  function ncompFalso(offset: number): number {
    return 900000000 + (Date.now() % 100000) + offset
  }

  it('arma el encabezado y los renglones en las tablas de staging, ya contabilizado', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')

      const ncompInC = ncompFalso(0)
      const fechaFactura = new Date('2026-06-19T00:00:00Z')
      await escribirAsientoEn(tx, id, ncompInC, fechaFactura)

      const header = await tx.request().input('n', ncompInC).query(`
        SELECT * FROM ASIENTO_COMPROBANTE_CP WHERE NCOMP_IN_C = @n
      `)
      expect(header.recordset).toHaveLength(1)
      // Contabilizado al grabar -- decision del usuario, 2026-08-22. La
      // transferencia a Contabilidad ("pasar a contabilidad") sigue siendo
      // un proceso propio de Tango que corre el usuario desde el ERP.
      expect(header.recordset[0].ASIENTO_ANULACION).toBe('N')
      expect(header.recordset[0].CONTABILIZADO).toBe('S')
      expect(header.recordset[0].USUARIO_CONTABILIZACION).toBe('PHF_WEB')
      expect(new Date(header.recordset[0].FECHA_CONTABILIZACION).toISOString()).toBe(fechaFactura.toISOString())
      expect(header.recordset[0].TERMINAL_CONTABILIZACION).toBe(terminalActual())
      expect(header.recordset[0].TRANSFERIDO_CN).toBe('N')

      const idHeader = header.recordset[0].ID_ASIENTO_COMPROBANTE_CP
      const lineas = await tx.request().input('id', idHeader).query(`
        SELECT ac.NRO_RENGLON_ASIENTO_CP, ac.D_H, ac.IMPORTE_RENGLON_BASE_CP, ac.IMPORTE_RENGLON_ALTER_CP,
               ac.DESC_LEYENDA, ac.EDITA_CUENTA, c.COD_CUENTA
        FROM ASIENTO_CP ac JOIN CUENTA c ON c.ID_CUENTA = ac.ID_CUENTA
        WHERE ac.ID_ASIENTO_COMPROBANTE_CP = @id ORDER BY ac.NRO_RENGLON_ASIENTO_CP
      `)
      expect(lineas.recordset).toHaveLength(3) // Subtotal (concepto), IVA, Total.
      expect(lineas.recordset.map((l: { NRO_RENGLON_ASIENTO_CP: number }) => l.NRO_RENGLON_ASIENTO_CP)).toEqual([1, 2, 3])

      const filas = lineas.recordset as {
        D_H: string; IMPORTE_RENGLON_BASE_CP: string; IMPORTE_RENGLON_ALTER_CP: string
        EDITA_CUENTA: string; COD_CUENTA: string
      }[]

      const sb = filas.find((l) => l.COD_CUENTA === '51460') // TELEFONOS LOCALES, concepto de 010151.
      expect(sb).toMatchObject({ D_H: 'D', EDITA_CUENTA: 'S' })
      expect(Number(sb!.IMPORTE_RENGLON_BASE_CP)).toBe(10000)
      // Sin ajuste por inflacion: se graba igual al importe base -- decision
      // del usuario, 2026-08-22.
      expect(Number(sb!.IMPORTE_RENGLON_ALTER_CP)).toBe(10000)

      const iva = filas.find((l) => l.COD_CUENTA === '13405')
      expect(iva).toMatchObject({ D_H: 'D', EDITA_CUENTA: 'N' })
      expect(Number(iva!.IMPORTE_RENGLON_BASE_CP)).toBe(2100)

      const total = filas.find((l) => l.COD_CUENTA === '20002')
      expect(total).toMatchObject({ D_H: 'H', EDITA_CUENTA: 'S' })
      expect(Number(total!.IMPORTE_RENGLON_BASE_CP)).toBe(12100)

      const totalDebe = filas.filter((l) => l.D_H === 'D').reduce((a, l) => a + Number(l.IMPORTE_RENGLON_BASE_CP), 0)
      const totalHaber = filas.filter((l) => l.D_H === 'H').reduce((a, l) => a + Number(l.IMPORTE_RENGLON_BASE_CP), 0)
      expect(totalDebe).toBe(totalHaber)
    })
  })

  it('graba la leyenda del operador en lugar de la de cada renglon real', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'tipoFactura', 'conceptos')
      await guardarCampoEn(tx, id, 'codprovee', '010151')
      await guardarCampoEn(tx, id, 'neto', '10000,00')
      await guardarCampoEn(tx, id, 'total', '12100,00')
      await guardarCampoEn(tx, id, 'porciva1', '21')
      await guardarCampoEn(tx, id, 'impiva1', '2100,00')
      await guardarCampoEn(tx, id, 'leyendaAsiento', 'Referencia OC-4521')

      const ncompInC = ncompFalso(3)
      await escribirAsientoEn(tx, id, ncompInC, new Date('2026-06-19T00:00:00Z'))

      const header = await tx.request().input('n', ncompInC).query(`
        SELECT ID_ASIENTO_COMPROBANTE_CP FROM ASIENTO_COMPROBANTE_CP WHERE NCOMP_IN_C = @n
      `)
      const lineas = await tx.request().input('id', header.recordset[0].ID_ASIENTO_COMPROBANTE_CP).query(`
        SELECT DESC_LEYENDA FROM ASIENTO_CP WHERE ID_ASIENTO_COMPROBANTE_CP = @id
      `)
      expect(lineas.recordset).toHaveLength(3)
      for (const l of lineas.recordset as { DESC_LEYENDA: string }[]) {
        expect(l.DESC_LEYENDA.trim()).toBe('Referencia OC-4521')
      }
    })
  })

  it('no arma nada si el asiento no cierra', async () => {
    // Mismo fixture que "cuenta las lineas omitidas por falta de codigo":
    // una percepcion sin codigo deja el asiento desbalanceado.
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'leido' })
      await guardarCampoEn(tx, id, 'neto', '1000,00')
      await guardarCampoEn(tx, id, 'total', '1050,00')
      await guardarCampoEn(tx, id, 'percep1', 'Jurisdiccion inventada que no existe')
      await guardarCampoEn(tx, id, 'imppercep1', '50,00')

      const ncompInC = ncompFalso(1)
      await expect(escribirAsientoEn(tx, id, ncompInC, new Date('2026-06-19T00:00:00Z'))).rejects.toThrow(/no cierra/)

      const header = await tx.request().input('n', ncompInC).query(`
        SELECT COUNT(*) AS n FROM ASIENTO_COMPROBANTE_CP WHERE NCOMP_IN_C = @n
      `)
      expect(Number(header.recordset[0].n)).toBe(0)
    })
  })

  it('no escribe nada si el comprobante no tiene ninguna linea que armar', async () => {
    await conRollback(async (tx) => {
      const id = await insertarComprobantePrueba(tx, { estado: 'procesando' })
      const ncompInC = ncompFalso(2)
      await escribirAsientoEn(tx, id, ncompInC, new Date('2026-06-19T00:00:00Z'))

      const header = await tx.request().input('n', ncompInC).query(`
        SELECT COUNT(*) AS n FROM ASIENTO_COMPROBANTE_CP WHERE NCOMP_IN_C = @n
      `)
      expect(Number(header.recordset[0].n)).toBe(0)
    })
  })
})
