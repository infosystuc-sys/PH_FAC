import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, auditarEn } from '@/server/app/detalle'
import { nComp as armarNComp, parsearFechaArg } from '@/lib/validaciones'
import { parsearImporte } from '@/lib/formato'
import { usuarioActual } from '@/lib/usuario'
import type { RegistroTango } from './comprobantes'

/**
 * El alta de un REMITO DE PROVEEDOR en Tango: la entrada de mercadería que
 * después factura el proveedor. Pedido del usuario, 2026-10-25.
 *
 * Un remito no es un comprobante de Compras sino un movimiento de Stock:
 * cabecera en STA14 y renglones en STA20, con `TCOMP_IN_S = 'RP'`. Todo lo
 * que sigue está copiado de los 4.092 remitos que Tango ya grabó en esta
 * base, no de la documentación:
 *
 * - Cabecera: `T_COMP = 'REM'`, `MOTIVO_REM = 'C'`, `TALONARIO = 30` y
 *   `ESTADO_MOV = 'P'` (pendiente de facturar; pasa a 'F' cuando una factura
 *   lo consume). Los 4.092 tienen esos mismos valores.
 * - `N_COMP` es el número que imprime el PROVEEDOR, con la letra R:
 *   "R0001100025490". El nuestro, interno, es `NCOMP_IN_S` ("00004207") y
 *   sale del talonario 30 de Compras (`CPA56`, "INFORME RECEPCION", TIPO_COMP
 *   'R'), cuyo `PROXIMO` Tango avanza en cada remito.
 * - Renglón: `TIPO_MOV = 'E'` (entrada), `CANT_PEND` = la cantidad (queda
 *   pendiente de facturar entera) y, si va contra una orden de compra,
 *   `N_ORDEN_CO`/`N_RENGL_OC`/`TALONARIO_OC` y `CANT_OC` con lo recibido.
 *   Los precios van en 0, igual que en los remitos reales contra OC: el
 *   precio que vale es el de la factura.
 *
 * Y lo que Tango mantiene por fuera del comprobante, que ningún trigger
 * hace solo (los triggers de STA14/STA19 solo replican a otras sucursales):
 *
 * - El vínculo de cada renglón con su orden en `CPA_OC_REMITO`: una fila
 *   por renglón de STA20 que va contra una OC (10.355 de 10.364 renglones
 *   RP con orden la tienen). Pedido del usuario, 2026-10-29.
 * - El saldo del depósito (`STA19.CANT_STOCK`) sube con la cantidad. Entra
 *   siempre al depósito 01 -- decisión del usuario, 2026-10-25.
 * - `STA19.CANT_PEND` es lo pendiente de recibir de las órdenes de compra
 *   abiertas, por artículo y depósito: verificado sobre las 7.480 filas, en
 *   7.478 vale exactamente la suma de `CPA36.CAN_PENDIE` de las órdenes
 *   emitidas. Recibir contra una orden lo baja.
 * - Los contadores de la orden (`CPA36`): `CAN_RECIBI` acumula, y
 *   `CAN_PENDIE`, `PENDIENTE_FACTURAR_RECIBIDA` y
 *   `PENDIENTE_RECIBIR_FACTURADA` se recalculan con las reglas que cumplen
 *   7.737, 7.794 y 7.797 de las 7.840 filas reales (ver `contadoresOc`).
 *
 * Imputar a la orden es decisión del usuario (2026-10-25): el remito se
 * revisa igual que una factura de artículos, eligiendo la OC de cada
 * renglón, solo que contra lo pendiente de RECIBIR.
 */

const TCOMP_IN_S = 'RP'
const T_COMP = 'REM'
const DEPOSITO = '01'

type Ejecutor = { request(): sql.Request }

/** "R" + punto de venta a 5 + número a 8, como lo guarda STA14.N_COMP. */
export function nCompRemito(ptovta: string, nro: string): string {
  return armarNComp('R', ptovta, nro)
}

/**
 * El remito de este proveedor con este número, si Tango ya lo tiene. Es el
 * chequeo de duplicados del remito, el equivalente de `buscarFacturaEnCpa04`.
 */
export async function buscarRemitoEnSta14(
  codProvee: string,
  nComp: string,
  e?: Ejecutor,
): Promise<{ ncompInS: string; nComp: string; fecha: Date | null } | null> {
  const ej = e ?? (await getPool())
  const r = await ej
    .request()
    .input('prov', sql.VarChar(6), codProvee.trim())
    .input('n', sql.VarChar(14), nComp)
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(NCOMP_IN_S)) AS ncompInS, LTRIM(RTRIM(N_COMP)) AS nComp, FECHA_MOV AS fecha
      FROM STA14
      WHERE TCOMP_IN_S = 'RP' AND LTRIM(RTRIM(COD_PRO_CL)) = @prov AND N_COMP = @n
    `)
  const f = r.recordset[0]
  return f ? { ncompInS: String(f.ncompInS), nComp: String(f.nComp), fecha: f.fecha ?? null } : null
}

/**
 * Los contadores de un renglón de orden de compra después de recibir
 * `cantidad`. Las reglas salen de la base, no de la documentación:
 *
 *   CAN_PENDIE = pedida - recibida - cerrada, sin bajar de 0   (7.737/7.840)
 *   PENDIENTE_FACTURAR_RECIBIDA = recibida - facturada, >= 0   (7.794/7.840)
 *   PENDIENTE_RECIBIR_FACTURADA = facturada - recibida, >= 0   (7.797/7.840)
 */
export function contadoresOc(
  oc: { pedida: number; recibida: number; cerrada: number; facturada: number },
  cantidad: number,
) {
  const recibida = oc.recibida + cantidad
  return {
    recibida,
    pendienteRecibir: Math.max(0, oc.pedida - recibida - oc.cerrada),
    pendienteFacturarRecibida: Math.max(0, recibida - oc.facturada),
    pendienteRecibirFacturada: Math.max(0, oc.facturada - recibida),
  }
}

function horaActual(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

type RenglonARegistrar = {
  codArticu: string
  cantidad: number
  oc: { nOrdenCo: string; nRenglOc: number } | null
}

export async function registrarRemitoEn(tx: sql.Transaction, id: number): Promise<RegistroTango> {
  await tx.request().query(`EXEC sp_getapplock @Resource='PHF_registro_tango', @LockMode='Exclusive'`)

  // 1. Idempotencia, igual que la factura.
  const previo = await tx.request().input('id', sql.Int, id).query(`
    SELECT TANGO_NCOMP_IN_C, TANGO_T_COMP, TANGO_N_COMP FROM PHF_COMPROBANTE WHERE ID=@id`)
  if (previo.recordset[0]?.TANGO_NCOMP_IN_C != null) {
    return {
      ncompInC: Number(previo.recordset[0].TANGO_NCOMP_IN_C),
      tComp: String(previo.recordset[0].TANGO_T_COMP).trim(),
      nComp: String(previo.recordset[0].TANGO_N_COMP).trim(),
    }
  }

  const detalle = await obtenerDetalleEn(tx, id)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  // 2. Cabecera: proveedor, número y fecha.
  const codProvee = (valores.codprovee ?? '').trim()
  if (!codProvee) throw new Error('Falta resolver el proveedor del remito.')
  const prov = await tx.request().input('cod', sql.VarChar(6), codProvee)
    .query(`SELECT 1 AS x FROM CPA01 WHERE COD_PROVEE=@cod`)
  if (prov.recordset.length === 0) throw new Error(`El proveedor ${codProvee} ya no existe en Tango.`)

  const ptovta = (valores.ptovta ?? '').trim()
  const nro = (valores.nro ?? '').trim()
  if (!ptovta || !nro) throw new Error('Falta el punto de venta o el número del remito.')
  const nComp = nCompRemito(ptovta, nro)
  if (nComp.length !== 14) {
    throw new Error(`El número de remito ${ptovta}-${nro} no entra en el formato de Tango.`)
  }

  const fecha = parsearFechaArg((valores.fecha ?? '').trim())
  if (!fecha) throw new Error(`No se pudo interpretar la fecha "${valores.fecha ?? ''}" del remito.`)

  const duplicado = await buscarRemitoEnSta14(codProvee, nComp, tx)
  if (duplicado) {
    throw new Error(`El remito ${nComp} de este proveedor ya está en Tango (interno ${duplicado.ncompInS}).`)
  }

  // 3. Renglones: los imputados a una orden y los cargos del proveedor (sin
  // orden, con artículo vinculado), igual que en la factura de artículos.
  const renglones: RenglonARegistrar[] = []
  for (const r of detalle.renglones) {
    const codArticu = (r.codigoFinal ?? r.codigo ?? '').trim()
    if (!codArticu) {
      throw new Error('Hay un renglón sin artículo de Tango: vinculalo antes de registrar.')
    }
    const cantidad = parsearImporte(r.cantidad)
    if (!(cantidad > 0)) {
      throw new Error(`El artículo ${codArticu} no tiene una cantidad válida.`)
    }
    renglones.push({
      codArticu,
      cantidad,
      oc: r.ocNOrdenCo && r.ocNRenglOc ? { nOrdenCo: r.ocNOrdenCo, nRenglOc: r.ocNRenglOc } : null,
    })
  }
  if (renglones.length === 0) {
    throw new Error('El remito no tiene renglones para registrar: imputale la orden de compra.')
  }

  // 4. Numero interno: el PROXIMO del talonario de remitos de Compras, sin
  // quedar por debajo de lo que ya existe (si alguien grabo un remito sin
  // avanzar el talonario, el siguiente no puede repetir su numero).
  const talonarios = await tx.request().query(`
    SELECT TALONARIO, PROXIMO FROM CPA56 WITH (UPDLOCK) WHERE TIPO_COMP = 'R'`)
  if (talonarios.recordset.length !== 1) {
    throw new Error(
      `Se esperaba un solo talonario de remitos de proveedor en Tango (CPA56, tipo R) y hay ` +
        `${talonarios.recordset.length}.`,
    )
  }
  const talonario = Number(talonarios.recordset[0].TALONARIO)
  const maxR = await tx.request().query(`
    SELECT ISNULL(MAX(TRY_CAST(NCOMP_IN_S AS INT)), 0) AS mx
    FROM STA14 WHERE TCOMP_IN_S = 'RP'`)
  const numero = Math.max(Number(talonarios.recordset[0].PROXIMO) || 0, Number(maxR.recordset[0].mx) + 1)
  const ncompInS = String(numero).padStart(8, '0')

  const hora = horaActual()
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const usuario = usuarioActual()
  const observacion = (valores.leyendaAsiento ?? '').trim().slice(0, 30)

  // 5. STA14.
  const cabecera = await tx.request()
    .input('ncompInS', sql.VarChar(8), ncompInS)
    .input('nComp', sql.VarChar(14), nComp)
    .input('prov', sql.VarChar(6), codProvee)
    .input('fecha', sql.DateTime, fecha)
    .input('talonario', sql.SmallInt, talonario)
    .input('obs', sql.VarChar(30), observacion)
    .input('usuario', sql.VarChar(30), usuario.slice(0, 30))
    .input('usuarioIngreso', sql.VarChar(120), usuario)
    .input('hora', sql.VarChar(6), hora)
    .input('hoy', sql.DateTime, hoy)
    .query(`
      DECLARE @ids TABLE (ID_STA14 INT);
      INSERT INTO STA14 (
        TCOMP_IN_S, NCOMP_IN_S, T_COMP, N_COMP, COD_PRO_CL, FECHA_MOV, ESTADO_MOV,
        MOTIVO_REM, TALONARIO, COTIZ, MON_CTE, HORA, HORA_COMP, USUARIO, OBSERVACIO,
        DIFERENCIA, FECHA_INGRESO, HORA_INGRESO, USUARIO_INGRESO, TERMINAL_INGRESO,
        NRO_SUCURSAL_DESTINO_REMITO, COD_DEPOSI
      )
      OUTPUT INSERTED.ID_STA14 INTO @ids
      VALUES (
        'RP', @ncompInS, 'REM', @nComp, @prov, @fecha, 'P',
        'C', @talonario, 1, 1, '0000', @hora, @usuario, @obs,
        'N', @hoy, @hora, @usuarioIngreso, 'PHF-WEB',
        0, ''
      );
      SELECT ID_STA14 FROM @ids;`)
  const idSta14 = Number(cabecera.recordset[0].ID_STA14)

  const deposito = await tx.request().input('dep', sql.VarChar(2), DEPOSITO)
    .query(`SELECT ID_STA22 FROM STA22 WHERE COD_SUCURS = @dep`)
  const idSta22: number | null = deposito.recordset[0]?.ID_STA22 ?? null

  const ocsAfectadas = new Set<string>()
  let nRenglS = 0
  for (const r of renglones) {
    nRenglS += 1

    // El articulo tiene que poder entrar a stock: Tango no deja un articulo
    // sin stock ni uno con numero de serie en un remito sin pedir los datos
    // que esta app no tiene, y un base de escala no es un articulo real.
    const art = await tx.request().input('art', sql.VarChar(15), r.codArticu).query(`
      SELECT ID_STA11, ID_MEDIDA_STOCK, ID_MEDIDA_VENTAS, STOCK, USA_SERIE, USA_PARTID,
             LTRIM(RTRIM(ISNULL(USA_ESC, 'N'))) AS USA_ESC
      FROM STA11 WHERE COD_ARTICU = @art`)
    const a = art.recordset[0]
    if (!a) throw new Error(`El artículo ${r.codArticu} no existe en Tango.`)
    if (!a.STOCK) throw new Error(`El artículo ${r.codArticu} no lleva stock en Tango: no puede entrar por remito.`)
    if (a.USA_SERIE) {
      throw new Error(`El artículo ${r.codArticu} usa número de serie: ese remito hay que cargarlo desde Tango.`)
    }
    if (a.USA_PARTID) {
      throw new Error(`El artículo ${r.codArticu} usa partidas: ese remito hay que cargarlo desde Tango.`)
    }
    if (a.USA_ESC === 'B') {
      throw new Error(`El artículo ${r.codArticu} es un artículo base de escala: elegí el color o el talle.`)
    }

    // La orden, releida dentro de la transaccion: entre la revision y este
    // momento otro remito pudo haber recibido parte de lo pendiente.
    let oc: {
      nOrdenCo: string
      nRenglOc: number
      talonario: number
      deposito: string
      pendiente: number
      pedida: number
      recibida: number
      cerrada: number
      facturada: number
      estado: number
    } | null = null
    if (r.oc) {
      const fila = await tx.request()
        .input('oc', sql.VarChar(14), r.oc.nOrdenCo).input('r', sql.Int, r.oc.nRenglOc)
        .query(`
          SELECT LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU, LTRIM(RTRIM(ISNULL(r.COD_DEPOSI,''))) AS COD_DEPOSI,
                 ISNULL(r.CAN_PEDIDA,0) AS CAN_PEDIDA, ISNULL(r.CAN_RECIBI,0) AS CAN_RECIBI,
                 ISNULL(r.CAN_PENDIE,0) AS CAN_PENDIE, ISNULL(r.CANTIDAD_CERRADA,0) AS CANTIDAD_CERRADA,
                 ISNULL(r.CANTIDAD_FACTURADA,0) AS CANTIDAD_FACTURADA, ISNULL(r.ESTADO,0) AS ESTADO,
                 h.TALONARIO
          FROM CPA36 r WITH (UPDLOCK) JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO
          WHERE r.N_ORDEN_CO=@oc AND r.N_RENGL_OC=@r`)
      const f = fila.recordset[0]
      if (!f) {
        throw new Error(`El renglón ${r.oc.nRenglOc} de la orden de compra ${r.oc.nOrdenCo.trim()} ya no existe.`)
      }
      if (r.cantidad - Number(f.CAN_PENDIE) > 0.00005) {
        throw new Error(
          `El artículo ${r.codArticu} recibe ${r.cantidad} y la orden ${r.oc.nOrdenCo.trim()} ` +
            `tiene ${Number(f.CAN_PENDIE)} pendiente(s) de recibir.`,
        )
      }
      oc = {
        nOrdenCo: r.oc.nOrdenCo,
        nRenglOc: r.oc.nRenglOc,
        talonario: Number(f.TALONARIO) || 0,
        deposito: String(f.COD_DEPOSI) || DEPOSITO,
        pendiente: Number(f.CAN_PENDIE),
        pedida: Number(f.CAN_PEDIDA),
        recibida: Number(f.CAN_RECIBI),
        cerrada: Number(f.CANTIDAD_CERRADA),
        facturada: Number(f.CANTIDAD_FACTURADA),
        estado: Number(f.ESTADO),
      }
    }

    // 6. STA20.
    await tx.request()
      .input('ncompInS', sql.VarChar(8), ncompInS)
      .input('nRenglS', sql.Int, nRenglS)
      .input('art', sql.VarChar(15), r.codArticu)
      .input('dep', sql.VarChar(2), DEPOSITO)
      .input('cant', sql.Decimal(18, 4), r.cantidad)
      .input('cantOc', sql.Decimal(18, 4), oc ? r.cantidad : 0)
      .input('fecha', sql.DateTime, fecha)
      .input('oc', sql.VarChar(14), oc?.nOrdenCo ?? '')
      .input('nRenglOc', sql.Int, oc?.nRenglOc ?? 0)
      .input('talonarioOc', sql.SmallInt, oc?.talonario ?? 0)
      .input('medidaStock', sql.Int, a.ID_MEDIDA_STOCK ?? null)
      .input('medidaVentas', sql.Int, a.ID_MEDIDA_VENTAS ?? null)
      .input('idSta11', sql.Int, a.ID_STA11 ?? null)
      .input('idSta14', sql.Int, idSta14)
      .query(`
        INSERT INTO STA20 (
          TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S, COD_ARTICU, COD_DEPOSI, TIPO_MOV, FECHA_MOV,
          CANTIDAD, CANT_PEND, CANT_FACTU, CANT_DEV, CANT_OC, CAN_EQUI_V, EQUIVALENC,
          N_ORDEN_CO, N_RENGL_OC, TALONARIO_OC, PRECIO, PRECIO_REM, PLISTA_REM,
          PRECIO_REMITO_VENTAS, UNIDAD_MEDIDA_SELECCIONADA,
          ID_MEDIDA_STOCK, ID_MEDIDA_VENTAS, ID_STA11, ID_STA14
        ) VALUES (
          'RP', @ncompInS, @nRenglS, @art, @dep, 'E', @fecha,
          @cant, @cant, 0, 0, @cantOc, 1, 1,
          @oc, @nRenglOc, @talonarioOc, 0, 0, 0,
          0, 'P',
          @medidaStock, @medidaVentas, @idSta11, @idSta14
        )`)

    // 7. STA19: el saldo del deposito sube. Si el articulo nunca tuvo saldo
    // en el 01 la fila no existe y se crea.
    await tx.request()
      .input('art', sql.VarChar(15), r.codArticu)
      .input('dep', sql.VarChar(2), DEPOSITO)
      .input('cant', sql.Decimal(18, 4), r.cantidad)
      .input('idSta11', sql.Int, a.ID_STA11 ?? null)
      .input('idSta22', sql.Int, idSta22)
      .query(`
        UPDATE STA19 SET CANT_STOCK = ISNULL(CANT_STOCK, 0) + @cant
        WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep;
        IF @@ROWCOUNT = 0
          INSERT INTO STA19 (COD_ARTICU, COD_DEPOSI, CANT_STOCK, CANT_COMP, CANT_PEND, ID_STA11, ID_STA22)
          VALUES (@art, @dep, @cant, 0, 0, @idSta11, @idSta22);`)

    if (oc) {
      // 7b. El vinculo renglon de remito <-> renglon de OC en CPA_OC_REMITO
      // (2026-10-29, pedido del usuario). Una fila por renglon de STA20 que
      // va contra una orden, con el patron de las 10.355 filas RP reales:
      // CANTIDAD = la del renglon, CANT_OC = la que va contra la orden (son
      // iguales salvo que Tango reciba de mas, cosa que esta app no deja),
      // la clave de la OC igual a la de STA20, y las cantidades de segunda
      // unidad y de devolucion en 0. ID_CPA_OC_REMITO es identity.
      await tx.request()
        .input('cant', sql.Decimal(18, 4), r.cantidad)
        .input('cantOc', sql.Decimal(18, 4), r.cantidad)
        .input('oc', sql.VarChar(14), oc.nOrdenCo)
        .input('nRenglOc', sql.Int, oc.nRenglOc)
        .input('talonarioOc', sql.SmallInt, oc.talonario)
        .input('ncompInS', sql.VarChar(8), ncompInS)
        .input('nRenglS', sql.Int, nRenglS)
        .query(`
          INSERT INTO CPA_OC_REMITO (
            CANTIDAD, CANT_OC, N_ORDEN_CO, N_RENGL_OC, TALONARIO_OC,
            TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S, CANTIDAD_2, CANT_OC_2, CANT_DEV, CANT_DEV_2
          ) VALUES (
            @cant, @cantOc, @oc, @nRenglOc, @talonarioOc,
            'RP', @ncompInS, @nRenglS, 0, 0, 0, 0
          )`)

      // 8. Los contadores de la orden y lo pendiente de recibir del deposito
      // de la orden.
      const n = contadoresOc(oc, r.cantidad)
      await tx.request()
        .input('oc', sql.VarChar(14), oc.nOrdenCo).input('r', sql.Int, oc.nRenglOc)
        .input('recibida', sql.Decimal(18, 4), n.recibida)
        .input('pend', sql.Decimal(18, 4), n.pendienteRecibir)
        .input('pfr', sql.Decimal(18, 4), n.pendienteFacturarRecibida)
        .input('prf', sql.Decimal(18, 4), n.pendienteRecibirFacturada)
        .query(`
          UPDATE CPA36
          SET CAN_RECIBI = @recibida, CAN_PENDIE = @pend,
              PENDIENTE_FACTURAR_RECIBIDA = @pfr, PENDIENTE_RECIBIR_FACTURADA = @prf,
              ESTADO = CASE WHEN @pend = 0 AND ESTADO IN (1, 2, 3, 9) THEN 10 ELSE ESTADO END
          WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r`)

      const baja = Math.min(r.cantidad, oc.pendiente)
      await tx.request()
        .input('art', sql.VarChar(15), r.codArticu)
        .input('dep', sql.VarChar(2), oc.deposito)
        .input('baja', sql.Decimal(18, 4), baja)
        .query(`
          UPDATE STA19
          SET CANT_PEND = CASE WHEN ISNULL(CANT_PEND, 0) - @baja < 0 THEN 0 ELSE ISNULL(CANT_PEND, 0) - @baja END
          WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep`)

      ocsAfectadas.add(oc.nOrdenCo)
    }
  }

  // 9. Una orden sin nada pendiente de recibir pasa a Cumplida (estado 10).
  // Mismo conjunto de estados de origen que usa la factura: no se tocan las
  // anuladas ni las ya cerradas.
  for (const oc of ocsAfectadas) {
    const pend = await tx.request().input('oc', sql.VarChar(14), oc).query(`
      SELECT SUM(ISNULL(CAN_PENDIE, 0)) AS pend FROM CPA36 WHERE N_ORDEN_CO=@oc`)
    if (Number(pend.recordset[0].pend) <= 0) {
      await tx.request().input('oc', sql.VarChar(14), oc).query(`
        UPDATE CPA35 SET ESTADO=10, ID_ESTADO_ORDEN_COMPRA=10
        WHERE N_ORDEN_CO=@oc AND ESTADO IN (1, 2, 3, 9)`)
    }
  }

  // 10. El talonario avanza, igual que lo hace Tango.
  await tx.request()
    .input('talonario', sql.SmallInt, talonario)
    .input('proximo', sql.VarChar(8), String(numero + 1).padStart(8, '0'))
    .query(`UPDATE CPA56 SET PROXIMO = @proximo WHERE TALONARIO = @talonario AND TIPO_COMP = 'R'`)

  // 11. PHF_COMPROBANTE + auditoria. El numero interno va a la misma columna
  // que el de la factura: es el identificador de Tango de este comprobante.
  await tx.request()
    .input('id', sql.Int, id).input('numero', sql.Float, numero)
    .input('tComp', sql.VarChar(10), T_COMP).input('nComp', sql.VarChar(20), nComp)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO='registrado', TANGO_NCOMP_IN_C=@numero, TANGO_T_COMP=@tComp, TANGO_N_COMP=@nComp,
          FECHA_REGISTRO=SYSDATETIME(), FECHA_MODIF=SYSDATETIME()
      WHERE ID=@id`)
  const conOc = renglones.filter((r) => r.oc).length
  await auditarEn(
    tx,
    id,
    `Registrado en Tango: remito ${nComp} (interno ${TCOMP_IN_S} ${ncompInS}) — ` +
      `${renglones.length} renglón(es) al depósito ${DEPOSITO}` +
      (conOc > 0 ? `, ${conOc} contra orden de compra` : ''),
  )

  return { ncompInC: numero, tComp: T_COMP, nComp }
}
