import sql from 'mssql'
import { getPool } from '../db/pool'
import { fijarXactAbort } from '../db/tx'
import { obtenerDetalleEn, auditarEn } from '@/server/app/detalle'
import { nComp as armarNComp, parsearFechaArg } from '@/lib/validaciones'
import { parsearImporte } from '@/lib/formato'
import { usuarioActual } from '@/lib/usuario'
import type { RegistroTango } from './comprobantes'
import { seriesEfectivasEn } from '@/server/app/series'
import { problemaSeries, type Serie } from '@/lib/series'
import { grabarSeriesRemitoEn } from './series'
import { renglonFacturaParaRemitoEn, proveedorDeFacturaEn } from './facturasParaRemito'
import { ncompInCEnCpa48 } from './remitosFactura'
import { normalizarCodigo } from '@/lib/cotejoOc'
import type { CandidatoFactura } from '@/lib/remitoFactura'
import { actualizarEstadoStkEn, marcarModificacionOcEn } from './estadoCircuito'

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
 * - Los números de serie de los artículos con `STA11.USA_SERIE`, uno por
 *   unidad, en `STA07` (historial) y `STA06` (series en stock). Pedido del
 *   usuario, 2026-11-04: los carga el operador en la revisión. Ver
 *   `series.ts`.
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
 * Desde el 2026-11-16 (pedido del usuario) el remito se vincula a la
 * FACTURA de compra ya registrada que recibe, no a una OC: hasta ese día se
 * elegía la OC de cada renglón. Cada renglón con factura graba, copiado de
 * los 5.685 renglones que Tango grabó después de su factura:
 *
 * - `STA20` con `CANT_PEND = 0` y `CANT_FACTU` = la cantidad;
 * - `CPA48` (factura ↔ remito) con la cantidad, y `CPA46.FALTA_REM` baja;
 * - si la factura se imputó a una OC (`CPA_OC_FACTURA`), el remito la
 *   hereda: la OC en `STA20`, `CPA_OC_REMITO`, `CPA_OC_REMITO_FACTURA` y los
 *   contadores de recepción de `CPA36` / `STA19.CANT_PEND`;
 * - `STA14.ESTADO_MOV = 'F'` si no le queda ningún renglón pendiente.
 *
 * Un renglón sin factura entra a stock sin vincularse a nada (ni factura ni
 * OC), y solo si el operador confirmó grabarlo sin comprobante de
 * referencia. Ver src/server/app/remitoFactura.ts.
 *
 * El 2026-11-17 se alineó el remito contra una factura con OC con lo que
 * grabó Tango 26.1 en el remito R0000100001704 (relevado con foto de la base
 * y traza, D:\TGA_MOV\envio_app\informe_remito_tango.md):
 *
 * - `CPA04.ESTADO_STK` de la factura se recalcula (`'R'` si no le queda
 *   nada sin remitir);
 * - el renglón de la OC que queda sin pendiente de recibir lleva además
 *   `CIERRE = 1` y `REC_MAS_OC = 'S'`;
 * - la cabecera de la OC actualiza su auditoría de modificación;
 * - `STA19.FECHA_ACTUALIZACION_SALDO` = ahora;
 * - `STA20.PRECIO_REM`, `PLISTA_REM` y `PRECIO_REMITO_VENTAS` llevan el
 *   precio del renglón de la factura (`CPA46.PRECIO_NET`); `PRECIO` sigue en 0;
 * - el depósito es el del renglón de la OC (`CPA36.COD_DEPOSI`) en `STA20`,
 *   `STA19` y las series; el 01 queda para lo que no tiene OC.
 */

const TCOMP_IN_S = 'RP'
const T_COMP = 'REM'
/** El depósito de lo que entra sin orden de compra (decisión del usuario, 2026-10-25). */
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
  /**
   * Dentro del registro: con `UPDLOCK, HOLDLOCK`, para que nadie inserte el
   * mismo remito hasta el commit (la transaccion corre en READ COMMITTED
   * desde el 2026-11-17).
   */
  bloquear = false,
): Promise<{ ncompInS: string; nComp: string; fecha: Date | null } | null> {
  const ej = e ?? (await getPool())
  const r = await ej
    .request()
    .input('prov', sql.VarChar(6), codProvee.trim())
    .input('n', sql.VarChar(14), nComp)
    .query(`
      SELECT TOP 1 LTRIM(RTRIM(NCOMP_IN_S)) AS ncompInS, LTRIM(RTRIM(N_COMP)) AS nComp, FECHA_MOV AS fecha
      FROM STA14 ${bloquear ? 'WITH (UPDLOCK, HOLDLOCK)' : ''}
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

export type RenglonARegistrar = {
  renglonId: number
  codArticu: string
  cantidad: number
  /** El renglón de la factura que recibe (CPA46), o `null` sin referencia. */
  factura: { tcompInC: string; ncompInC: number; nRenglC: number } | null
}

export async function registrarRemitoEn(tx: sql.Transaction, id: number): Promise<RegistroTango> {
  // Mismo criterio que la factura (punto 6 de la revision contra Tango,
  // 2026-11-17): XACT_ABORT ON y READ COMMITTED con bloqueos explicitos en
  // lo que decide algo (ver grabarRemitoEn). Si llega desde
  // registrarComprobanteEn ya esta en ON; se repite por si se llama sola.
  await fijarXactAbort(tx, true)
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

  // 3. Renglones, cada uno con el renglon de la factura que recibe
  // (2026-11-16). Los que no tienen factura solo entran si el operador
  // confirmo grabarlos sin comprobante de referencia.
  const sinRef = await tx.request().input('id', sql.Int, id)
    .query('SELECT REMITO_SIN_REFERENCIA AS x FROM PHF_COMPROBANTE WHERE ID = @id')
  const sinReferenciaConfirmado = Boolean(sinRef.recordset[0]?.x)
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
      renglonId: r.id,
      codArticu,
      cantidad,
      factura: r.factura
        ? { tcompInC: r.factura.tcompInC, ncompInC: r.factura.ncompInC, nRenglC: r.factura.nRenglC }
        : null,
    })
  }
  if (renglones.length === 0) {
    throw new Error('El remito no tiene renglones para registrar: reprocesá el comprobante.')
  }
  if (!sinReferenciaConfirmado && renglones.some((r) => !r.factura)) {
    throw new Error(
      'Hay renglones sin factura de referencia: elegí la factura o confirmá grabarlos sin comprobante de referencia.',
    )
  }

  const observacion = (valores.leyendaAsiento ?? '').trim().slice(0, 30)
  // Las series de los articulos que las usan: las que guardo el operador o,
  // si no las toco, las que la IA leyo del comprobante (2026-11-05).
  const seriesGuardadas = await seriesEfectivasEn(tx, id, detalle.renglones)

  const g = await grabarRemitoEn(tx, { codProvee, nComp, fecha, observacion, renglones, series: seriesGuardadas })

  // 11. PHF_COMPROBANTE + auditoria. El numero interno va a la misma columna
  // que el de la factura: es el identificador de Tango de este comprobante.
  await tx.request()
    .input('id', sql.Int, id).input('numero', sql.Float, g.numero)
    .input('tComp', sql.VarChar(10), T_COMP).input('nComp', sql.VarChar(20), nComp)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO='registrado', TANGO_NCOMP_IN_C=@numero, TANGO_T_COMP=@tComp, TANGO_N_COMP=@nComp,
          FECHA_REGISTRO=SYSDATETIME(), FECHA_MODIF=SYSDATETIME()
      WHERE ID=@id`)
  await auditarEn(tx, id, `Registrado en Tango: ${describirRemitoGrabado(nComp, g, renglones)}`)

  return { ncompInC: g.numero, tComp: T_COMP, nComp }
}

/** Lo que dejó grabado un remito, para el historial. */
export function describirRemitoGrabado(nComp: string, g: RemitoGrabado, renglones: RenglonARegistrar[]): string {
  const conFactura = renglones.filter((r) => r.factura).length
  return (
    `remito ${nComp} (interno ${TCOMP_IN_S} ${g.ncompInS}) — ` +
    `${renglones.length} renglón(es) al depósito ${(g.depositos.length > 0 ? g.depositos : [DEPOSITO]).join(', ')}` +
    (conFactura > 0 ? `, ${conFactura} contra la factura ${g.facturas.join(', ')}` : '') +
    (conFactura < renglones.length ? `, ${renglones.length - conFactura} sin comprobante de referencia` : '') +
    (g.ordenes.length > 0 ? `, orden de compra ${g.ordenes.map((o) => o.trim()).join(', ')}` : '') +
    (g.totalSeries > 0 ? `, ${g.totalSeries} número(s) de serie` : '')
  )
}

export type RemitoAGrabar = {
  codProvee: string
  /** "R" + punto de venta + número, ya validado (14 caracteres). */
  nComp: string
  fecha: Date
  observacion: string
  renglones: RenglonARegistrar[]
  /** Las series de cada renglón (por ID de PHF_RENGLON), ver `seriesEfectivasEn`. */
  series: Map<number, { series: Serie[] }>
}

export type RemitoGrabado = {
  numero: number
  ncompInS: string
  facturas: string[]
  ordenes: string[]
  totalSeries: number
  /** Los depósitos a los que entró la mercadería. */
  depositos: string[]
}

/**
 * El movimiento de Stock de un remito de proveedor, sin tocar
 * `PHF_COMPROBANTE`: lo usan el remito suelto (`registrarRemitoEn`) y la
 * factura-remito (2026-11-17, `registrarComprobanteEn`), que graba primero
 * la factura y después este remito, con el mismo número, recibiendo los
 * renglones de esa misma factura. Corre dentro de la transacción del que
 * llama, que ya tomó el applock.
 */
export async function grabarRemitoEn(tx: sql.Transaction, datos: RemitoAGrabar): Promise<RemitoGrabado> {
  const { codProvee, nComp, fecha, observacion, renglones } = datos
  const seriesGuardadas = datos.series

  const duplicado = await buscarRemitoEnSta14(codProvee, nComp, tx, true)
  if (duplicado) {
    throw new Error(`El remito ${nComp} de este proveedor ya está en Tango (interno ${duplicado.ncompInS}).`)
  }

  // 4. Numero interno: el PROXIMO del talonario de remitos de Compras, sin
  // quedar por debajo de lo que ya existe (si alguien grabo un remito sin
  // avanzar el talonario, el siguiente no puede repetir su numero).
  const talonarios = await tx.request().query(`
    SELECT TALONARIO, PROXIMO FROM CPA56 WITH (UPDLOCK, ROWLOCK, HOLDLOCK) WHERE TIPO_COMP = 'R'`)
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

  // El ID_STA22 de cada deposito, para la fila de STA19 que se crea si el
  // articulo nunca tuvo saldo ahi.
  const idsSta22 = new Map<string, number | null>()
  async function idSta22De(dep: string): Promise<number | null> {
    if (!idsSta22.has(dep)) {
      const d = await tx.request().input('dep', sql.VarChar(2), dep)
        .query(`SELECT ID_STA22 FROM STA22 WHERE COD_SUCURS = @dep`)
      idsSta22.set(dep, d.recordset[0]?.ID_STA22 ?? null)
    }
    return idsSta22.get(dep) ?? null
  }

  let totalSeries = 0

  // Las OC tocadas, por talonario + numero, y las facturas recibidas.
  const ocsAfectadas = new Map<string, { nOrdenCo: string; talonario: number }>()
  const facturasTocadas = new Set<string>()
  const facturasARecalcular = new Map<string, { tcompInC: string; ncompInC: number }>()
  const depositos = new Set<string>()
  let nRenglS = 0
  for (const r of renglones) {
    nRenglS += 1

    // El articulo tiene que poder entrar a stock: Tango no deja un articulo
    // sin stock ni uno con partidas en un remito sin pedir los datos que
    // esta app no tiene, y un base de escala no es un articulo real. Los que
    // usan numero de serie si entran desde el 2026-11-04: el operador carga
    // una serie por unidad en la revision (PHF_SERIE).
    const art = await tx.request().input('art', sql.VarChar(15), r.codArticu).query(`
      SELECT ID_STA11, ID_MEDIDA_STOCK, ID_MEDIDA_VENTAS, STOCK, USA_SERIE, USA_PARTID,
             LTRIM(RTRIM(ISNULL(USA_ESC, 'N'))) AS USA_ESC
      FROM STA11 WHERE COD_ARTICU = @art`)
    const a = art.recordset[0]
    if (!a) throw new Error(`El artículo ${r.codArticu} no existe en Tango.`)
    if (!a.STOCK) throw new Error(`El artículo ${r.codArticu} no lleva stock en Tango: no puede entrar por remito.`)
    const series = a.USA_SERIE
      ? (seriesGuardadas.get(r.renglonId)?.series ?? []).filter((s) => s.nSerie !== '')
      : []
    if (a.USA_SERIE) {
      const problema = problemaSeries(r.codArticu, r.cantidad, series)
      if (problema) throw new Error(problema)
    }
    if (a.USA_PARTID) {
      throw new Error(`El artículo ${r.codArticu} usa partidas: ese remito hay que cargarlo desde Tango.`)
    }
    if (a.USA_ESC === 'B') {
      throw new Error(`El artículo ${r.codArticu} es un artículo base de escala: elegí el color o el talle.`)
    }

    // La factura que recibe, releida con bloqueo dentro de la transaccion:
    // entre la revision y este momento otro remito pudo haberla recibido.
    let factura: CandidatoFactura | null = null
    if (r.factura) {
      factura = await renglonFacturaParaRemitoEn(tx, r.factura)
      if (!factura) {
        throw new Error(`El renglón ${r.factura.nRenglC} de la factura ya no existe en Tango.`)
      }
      const provFac = await proveedorDeFacturaEn(tx, r.factura)
      if (provFac !== codProvee) {
        throw new Error(`La factura ${factura.nComp} es de otro proveedor.`)
      }
      if (normalizarCodigo(factura.codArticu) !== normalizarCodigo(r.codArticu)) {
        throw new Error(`El renglón de la factura ${factura.nComp} es del artículo ${factura.codArticu}, no de ${r.codArticu}.`)
      }
      if (r.cantidad - factura.faltaRem > 0.00005) {
        throw new Error(
          `El artículo ${r.codArticu} recibe ${r.cantidad} y a la factura ${factura.nComp} le faltan recibir ${factura.faltaRem}.`,
        )
      }
    }

    // La orden: la de la factura, si la factura se imputo a una (decision
    // del usuario, 2026-11-16). Sin factura, el remito no toca ninguna OC.
    // Releida dentro de la transaccion por los contadores.
    const ocRef = factura?.oc ? { nOrdenCo: factura.oc.nOrdenCo, nRenglOc: factura.oc.nRenglOc } : null
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
    if (ocRef) {
      // Con el talonario de la OC que guardo la factura (CPA_OC_FACTURA):
      // dos talonarios pueden compartir numero de orden.
      const fila = await tx.request()
        .input('oc', sql.VarChar(14), ocRef.nOrdenCo).input('r', sql.Int, ocRef.nRenglOc)
        .input('tal', sql.SmallInt, factura?.oc?.talonario ?? null)
        .query(`
          SELECT LTRIM(RTRIM(r.COD_ARTICU)) AS COD_ARTICU, LTRIM(RTRIM(ISNULL(r.COD_DEPOSI,''))) AS COD_DEPOSI,
                 ISNULL(r.CAN_PEDIDA,0) AS CAN_PEDIDA, ISNULL(r.CAN_RECIBI,0) AS CAN_RECIBI,
                 ISNULL(r.CAN_PENDIE,0) AS CAN_PENDIE, ISNULL(r.CANTIDAD_CERRADA,0) AS CANTIDAD_CERRADA,
                 ISNULL(r.CANTIDAD_FACTURADA,0) AS CANTIDAD_FACTURADA, ISNULL(r.ESTADO,0) AS ESTADO,
                 h.TALONARIO
          FROM CPA36 r WITH (UPDLOCK, ROWLOCK)
          JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO AND h.TALONARIO = r.TALONARIO
          WHERE r.N_ORDEN_CO=@oc AND r.N_RENGL_OC=@r AND (@tal IS NULL OR r.TALONARIO = @tal)`)
      const f = fila.recordset[0]
      if (!f) {
        throw new Error(`El renglón ${ocRef.nRenglOc} de la orden de compra ${ocRef.nOrdenCo.trim()} ya no existe.`)
      }
      if (fila.recordset.length > 1) {
        throw new Error(`La orden de compra ${ocRef.nOrdenCo.trim()} existe en más de un talonario.`)
      }
      // Lo que se recibe ya lo controla FALTA_REM de la factura: la orden
      // no frena el remito (la factura ya se registro contra ella). Los
      // contadores no bajan de 0 (ver contadoresOc).
      oc = {
        nOrdenCo: ocRef.nOrdenCo,
        nRenglOc: ocRef.nRenglOc,
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

    // El deposito del renglon de la OC, como lo usa Tango en STA20, STA19 y
    // las series (2026-11-17). El 01 solo si no hay OC o la OC no tiene
    // deposito.
    const dep = oc?.deposito || DEPOSITO
    depositos.add(dep)

    // El precio del renglon: el que cobro la factura (CPA46.PRECIO_NET), en
    // las tres columnas de precio del remito, como Tango (2026-11-17). PRECIO
    // queda en 0, igual que en Tango. Sin factura, en 0 como siempre. Medido
    // en los remitos de Tango vinculados a una factura cuyo precio difiere
    // del de la OC: PRECIO_REM es el de la factura en 2.925, el de la OC en
    // 8 (base de desarrollo, 2026-11-17).
    const precioRem = factura?.precioNet ?? 0

    // 6. STA20. Contra una factura, el renglon nace facturado: CANT_PEND en 0
    // y CANT_FACTU = la cantidad, como en 5.683 y 5.525 de los 5.685
    // renglones que Tango grabo despues de su factura (2025 en adelante).
    await tx.request()
      .input('ncompInS', sql.VarChar(8), ncompInS)
      .input('nRenglS', sql.Int, nRenglS)
      .input('art', sql.VarChar(15), r.codArticu)
      .input('dep', sql.VarChar(2), dep)
      .input('precioRem', sql.Decimal(22, 7), precioRem)
      .input('cant', sql.Decimal(18, 4), r.cantidad)
      .input('pend', sql.Decimal(18, 4), factura ? 0 : r.cantidad)
      .input('factu', sql.Decimal(18, 4), factura ? r.cantidad : 0)
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
          @cant, @pend, @factu, 0, @cantOc, 1, 1,
          @oc, @nRenglOc, @talonarioOc, 0, @precioRem, @precioRem,
          @precioRem, 'P',
          @medidaStock, @medidaVentas, @idSta11, @idSta14
        )`)

    // 6b. Los numeros de serie: STA07 (historial del renglon) y STA06 (en
    // stock), al mismo deposito que el renglon. Ver series.ts.
    if (series.length > 0) {
      await grabarSeriesRemitoEn(tx, { ncompInS, nRenglS, codArticu: r.codArticu, deposito: dep, series })
      totalSeries += series.length
    }

    // 7. STA19: el saldo del deposito sube. Si el articulo nunca tuvo saldo
    // en ese deposito la fila no existe y se crea. FECHA_ACTUALIZACION_SALDO
    // con fecha y hora, como Tango (2026-11-17); el trigger
    // TR_STA19_FECHA_ACTUALIZACION_SALDO la estampa igual ante un cambio de
    // stock, pero no ante uno de pendiente (ver la baja de CANT_PEND).
    await tx.request()
      .input('art', sql.VarChar(15), r.codArticu)
      .input('dep', sql.VarChar(2), dep)
      .input('cant', sql.Decimal(18, 4), r.cantidad)
      .input('idSta11', sql.Int, a.ID_STA11 ?? null)
      .input('idSta22', sql.Int, await idSta22De(dep))
      .query(`
        UPDATE STA19 SET CANT_STOCK = ISNULL(CANT_STOCK, 0) + @cant, FECHA_ACTUALIZACION_SALDO = GETDATE()
        WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep;
        IF @@ROWCOUNT = 0
          INSERT INTO STA19 (COD_ARTICU, COD_DEPOSI, CANT_STOCK, CANT_COMP, CANT_PEND, ID_STA11, ID_STA22,
                             FECHA_ACTUALIZACION_SALDO)
          VALUES (@art, @dep, @cant, 0, 0, @idSta11, @idSta22, GETDATE());`)

    if (factura) {
      // 7a. El vinculo factura <-> remito en CPA48, una fila por renglon con
      // la cantidad del remito (2.730 de 2.749 y 2.936 de 2.936 en los reales),
      // y lo que la factura tiene sin recibir baja: FALTA_REM sigue siendo
      // CANTIDAD - lo cubierto en CPA48. El WHERE vuelve a exigir el saldo.
      await tx.request()
        .input('tcompInC', sql.VarChar(2), factura.tcompInC)
        .input('ncompInC', sql.VarChar(8), ncompInCEnCpa48(factura.ncompInC))
        .input('nRenglC', sql.Int, factura.nRenglC)
        .input('ncompInS', sql.VarChar(8), ncompInS)
        .input('nRenglS', sql.Int, nRenglS)
        .input('cantidad', sql.Decimal(18, 4), r.cantidad)
        .query(`
          INSERT INTO CPA48
            (TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S, CANTIDAD, CANTIDAD_2, FILLER)
          VALUES (@tcompInC, @ncompInC, @nRenglC, 'RP', @ncompInS, @nRenglS, @cantidad, 0, '')`)
      const baja = await tx.request()
        .input('t', sql.VarChar(2), factura.tcompInC)
        .input('n', sql.Float, factura.ncompInC)
        .input('r', sql.Int, factura.nRenglC)
        .input('cantidad', sql.Decimal(18, 4), r.cantidad)
        .query(`
          UPDATE CPA46 SET FALTA_REM = FALTA_REM - @cantidad
          WHERE TCOMP_IN_C = @t AND NCOMP_IN_C = @n AND N_RENGL_C = @r AND FALTA_REM >= @cantidad`)
      if (baja.rowsAffected[0] !== 1) {
        throw new Error(`A la factura ${factura.nComp} ya no le faltan recibir ${r.cantidad} de ${r.codArticu}.`)
      }
      facturasTocadas.add(factura.nComp)
      facturasARecalcular.set(`${factura.tcompInC}|${factura.ncompInC}`, {
        tcompInC: factura.tcompInC,
        ncompInC: factura.ncompInC,
      })
    }

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

      // 7c. El vinculo de tres puntas OC <-> factura <-> remito: los 2.749
      // renglones reales grabados despues de una factura con OC lo tienen.
      // Hasta lo que la factura imputo a la orden y no se asigno todavia a
      // otro remito (mismo criterio que consumirRemitosEn).
      const cantidadTriple = Math.min(r.cantidad, factura?.oc?.cantidad ?? 0)
      if (factura && cantidadTriple > 0) {
        await tx.request()
          .input('cantidad', sql.Decimal(18, 4), cantidadTriple)
          .input('talonario', sql.SmallInt, oc.talonario)
          .input('oc', sql.VarChar(14), oc.nOrdenCo)
          .input('nRenglOc', sql.Int, oc.nRenglOc)
          .input('tcompInC', sql.VarChar(2), factura.tcompInC)
          .input('ncompInC', sql.Float, factura.ncompInC)
          .input('nRenglC', sql.Int, factura.nRenglC)
          .input('ncompInS', sql.VarChar(8), ncompInS)
          .input('nRenglS', sql.Int, nRenglS)
          .query(`
            INSERT INTO CPA_OC_REMITO_FACTURA
              (CANTIDAD, CANTIDAD_2, TALONARIO_OC, N_ORDEN_CO, N_RENGL_OC,
               TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S)
            VALUES (@cantidad, 0, @talonario, @oc, @nRenglOc,
                    @tcompInC, @ncompInC, @nRenglC, 'RP', @ncompInS, @nRenglS)`)
      }

      // 8. Los contadores de la orden y lo pendiente de recibir del deposito
      // de la orden.
      //
      // Un renglon que queda sin nada pendiente de recibir lleva ademas
      // CIERRE = 1 y REC_MAS_OC = 'S', como lo dejo Tango en el remito
      // relevado el 17/11/2026 (2026-11-17). En la base, de los renglones de
      // OC con algo recibido y CAN_PENDIE = 0, 6.423 de 6.533 (98,3 %) tienen
      // esos dos valores. Con pendiente no se tocan: el remito parcial no
      // esta relevado.
      const n = contadoresOc(oc, r.cantidad)
      await tx.request()
        .input('oc', sql.VarChar(14), oc.nOrdenCo).input('r', sql.Int, oc.nRenglOc)
        .input('talonario', sql.SmallInt, oc.talonario)
        .input('recibida', sql.Decimal(18, 4), n.recibida)
        .input('pend', sql.Decimal(18, 4), n.pendienteRecibir)
        .input('pfr', sql.Decimal(18, 4), n.pendienteFacturarRecibida)
        .input('prf', sql.Decimal(18, 4), n.pendienteRecibirFacturada)
        .query(`
          UPDATE CPA36
          SET CAN_RECIBI = @recibida, CAN_PENDIE = @pend,
              PENDIENTE_FACTURAR_RECIBIDA = @pfr, PENDIENTE_RECIBIR_FACTURADA = @prf,
              CIERRE = CASE WHEN @pend = 0 THEN 1 ELSE CIERRE END,
              REC_MAS_OC = CASE WHEN @pend = 0 THEN 'S' ELSE REC_MAS_OC END,
              ESTADO = CASE WHEN @pend = 0 AND ESTADO IN (1, 2, 3, 9) THEN 10 ELSE ESTADO END
          WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r AND TALONARIO=@talonario`)

      const baja = Math.min(r.cantidad, oc.pendiente)
      await tx.request()
        .input('art', sql.VarChar(15), r.codArticu)
        .input('dep', sql.VarChar(2), dep)
        .input('baja', sql.Decimal(18, 4), baja)
        .query(`
          UPDATE STA19
          SET CANT_PEND = CASE WHEN ISNULL(CANT_PEND, 0) - @baja < 0 THEN 0 ELSE ISNULL(CANT_PEND, 0) - @baja END,
              FECHA_ACTUALIZACION_SALDO = GETDATE()
          WHERE COD_ARTICU = @art AND COD_DEPOSI = @dep`)

      ocsAfectadas.set(`${oc.talonario}|${oc.nOrdenCo}`, { nOrdenCo: oc.nOrdenCo, talonario: oc.talonario })
    }
  }

  // 8b. La factura recibida: 'R' si ya no le queda nada sin remitir, 'P' si
  // le queda (2026-11-17, como Tango: el remito total la paso de 'P' a 'R').
  for (const f of facturasARecalcular.values()) {
    await actualizarEstadoStkEn(tx, f.tcompInC, f.ncompInC)
  }

  // 9. Una orden sin nada pendiente de recibir pasa a Cumplida (estado 10).
  // Mismo conjunto de estados de origen que usa la factura: no se tocan las
  // anuladas ni las ya cerradas. Y, pase o no, la cabecera actualiza su
  // auditoria de modificacion, como Tango (2026-11-17).
  for (const oc of ocsAfectadas.values()) {
    const pend = await tx.request()
      .input('oc', sql.VarChar(14), oc.nOrdenCo).input('talonario', sql.SmallInt, oc.talonario)
      .query(`
        SELECT SUM(ISNULL(CAN_PENDIE, 0)) AS pend FROM CPA36 WHERE N_ORDEN_CO=@oc AND TALONARIO=@talonario`)
    if (Number(pend.recordset[0].pend) <= 0) {
      await tx.request()
        .input('oc', sql.VarChar(14), oc.nOrdenCo).input('talonario', sql.SmallInt, oc.talonario)
        .query(`
          UPDATE CPA35 SET ESTADO=10, ID_ESTADO_ORDEN_COMPRA=10
          WHERE N_ORDEN_CO=@oc AND TALONARIO=@talonario AND ESTADO IN (1, 2, 3, 9)`)
    }
    await marcarModificacionOcEn(tx, oc)
  }

  // 9b. Un remito sin ningun renglon pendiente de facturar nace facturado
  // ('F'), como 5.655 de los 5.685 que Tango grabo despues de su factura.
  await tx.request().input('ncompInS', sql.VarChar(8), ncompInS).query(`
    UPDATE STA14 SET ESTADO_MOV = 'F'
    WHERE TCOMP_IN_S = 'RP' AND NCOMP_IN_S = @ncompInS AND ESTADO_MOV = 'P'
      AND NOT EXISTS (SELECT 1 FROM STA20 s WHERE s.TCOMP_IN_S = 'RP' AND s.NCOMP_IN_S = @ncompInS AND s.CANT_PEND > 0)`)

  // 10. El talonario avanza, igual que lo hace Tango.
  await tx.request()
    .input('talonario', sql.SmallInt, talonario)
    .input('proximo', sql.VarChar(8), String(numero + 1).padStart(8, '0'))
    .query(`UPDATE CPA56 SET PROXIMO = @proximo WHERE TALONARIO = @talonario AND TIPO_COMP = 'R'`)

  return {
    numero,
    ncompInS,
    facturas: [...facturasTocadas],
    ordenes: [...ocsAfectadas.values()].map((o) => o.nOrdenCo),
    totalSeries,
    depositos: [...depositos],
  }
}
