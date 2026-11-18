import sql from 'mssql'
import { usuarioActual } from '@/lib/usuario'

type Ejecutor = { request(): sql.Request }

/**
 * Lo que el circuito orden de compra -> factura -> remito mantiene en las
 * cabeceras, y que usan tanto la factura (`registrarComprobanteEn`) como el
 * remito que la recibe (`grabarRemitoEn`). Relevado el 17/11/2026 cargando
 * desde Tango Compras 26.1 la factura A0000100001704 (con la OC
 * 0000100001704) y despues su remito R0000100001704, con foto de la base y
 * traza de Extended Events (D:\TGA_MOV\envio_app).
 */

/** `TERMINAL_*` con el que la app firma lo que graba, igual que `CPA04.TERMINAL_INGRESO`. */
export const TERMINAL_APP = 'PHF-WEB'

/**
 * `CPA04.ESTADO_STK` de una factura, recalculado desde sus renglones:
 * `'P'` (pendiente de remitir) si algun renglon de `CPA46` tiene
 * `FALTA_REM > 0`, `'R'` (remitida) si todos quedaron en 0.
 *
 * Las dos mitades salen de Tango: la factura con OC sin remito quedo en
 * `'P'` con `FALTA_REM` = cantidad en cada renglon, y el remito total la
 * paso a `'R'` al dejar todos los renglones en 0. Una factura sin renglones
 * en `CPA46` (conceptos, tarjeta) queda en `'R'`, que es lo que la app
 * grababa siempre.
 *
 * Hasta el 2026-11-17 la app grababa `'R'` fijo, copiado de la factura de
 * referencia 16591: una factura con `'R'` y renglones sin remitir queda
 * contradictoria para los procesos de Tango que buscan lo pendiente.
 */
export async function actualizarEstadoStkEn(
  e: Ejecutor,
  tcompInC: string,
  ncompInC: number,
): Promise<'P' | 'R'> {
  const r = await e
    .request()
    .input('t', sql.VarChar(2), tcompInC)
    .input('n', sql.Float, ncompInC)
    .query<{ estado: 'P' | 'R'; filas: number }>(`
      DECLARE @estado varchar(1) =
        CASE WHEN EXISTS (SELECT 1 FROM CPA46 WHERE TCOMP_IN_C = @t AND NCOMP_IN_C = @n AND FALTA_REM > 0)
             THEN 'P' ELSE 'R' END;
      DECLARE @filas int;
      UPDATE CPA04 SET ESTADO_STK = @estado WHERE TCOMP_IN_C = @t AND NCOMP_IN_C = @n;
      SET @filas = @@ROWCOUNT;
      SELECT @estado AS estado, @filas AS filas;`)
  const fila = r.recordset[0]
  if (!fila || fila.filas !== 1) {
    throw new Error(`No se encontró la factura ${tcompInC} ${ncompInC} para actualizar su estado de remitos.`)
  }
  return fila.estado
}

/**
 * La auditoria de modificacion de la cabecera de la orden de compra
 * (`CPA35`): fecha sin hora, hora `HHMMSS`, usuario y terminal.
 *
 * Tango la actualiza al facturar contra la OC y otra vez al recibir con el
 * remito, aunque en el mismo remito pase la OC a Cumplida. Tango relee esas
 * columnas para detectar si otro modifico la orden mientras un usuario la
 * tenia abierta: si la app no las toca, ese control no se entera.
 *
 * La fecha y la hora salen del reloj del servidor de SQL, juntas, para que
 * no queden de dos relojes distintos.
 */
export async function marcarModificacionOcEn(
  e: Ejecutor,
  oc: { nOrdenCo: string; talonario: number },
): Promise<void> {
  const r = await e
    .request()
    .input('oc', sql.VarChar(14), oc.nOrdenCo)
    .input('talonario', sql.SmallInt, oc.talonario)
    .input('usuario', sql.VarChar(120), usuarioActual().slice(0, 120))
    .input('terminal', sql.VarChar(255), TERMINAL_APP)
    .query<{ filas: number }>(`
      DECLARE @ahora datetime = GETDATE();
      DECLARE @filas int;
      UPDATE CPA35
         SET FECHA_ULTIMA_MODIFICACION = CAST(CAST(@ahora AS date) AS datetime),
             HORA_ULTIMA_MODIFICACION  = REPLACE(CONVERT(varchar(8), @ahora, 108), ':', ''),
             USUA_ULTIMA_MODIFICACION  = @usuario,
             TERM_ULTIMA_MODIFICACION  = @terminal
       WHERE N_ORDEN_CO = @oc AND TALONARIO = @talonario;
      SET @filas = @@ROWCOUNT;
      SELECT @filas AS filas;`)
  if (r.recordset[0]?.filas !== 1) {
    throw new Error(`No se encontró la orden de compra ${oc.nOrdenCo.trim()} (talonario ${oc.talonario}).`)
  }
}
