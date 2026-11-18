import sql from 'mssql'
import { getPool } from '../db/pool'
import type { CandidatoFactura } from '@/lib/remitoFactura'

type Ejecutor = { request(): sql.Request }

/**
 * Los renglones de facturas de compra de un proveedor que todavía tienen
 * mercadería sin recibir: `CPA46.FALTA_REM > 0` (2026-11-16, el remito se
 * vincula a la factura -- ver src/lib/remitoFactura.ts).
 *
 * `FALTA_REM` es `CANTIDAD − lo cubierto por remitos (CPA48)`: la regla que
 * cumplen los renglones que graba Tango, y la que mantiene la app desde el
 * 2026-11-04. Los vínculos remito → factura de la base son todos de
 * facturas `FP`, así que solo se miran ésas.
 *
 * Con cada renglón viene el de la orden de compra al que se imputó
 * (`CPA_OC_FACTURA`): el remito hereda esa orden (decisión del usuario).
 * `oc.cantidad` es lo que imputó la factura MENOS lo que ya se asignó a
 * otros remitos en `CPA_OC_REMITO_FACTURA`: es el tope de lo que el remito
 * puede llevar a ese vínculo de tres puntas.
 */
export async function renglonesFacturaSinRemito(
  codProvee: string,
  e?: Ejecutor,
): Promise<CandidatoFactura[]> {
  const prov = codProvee.trim()
  if (!prov) return []
  const ej = e ?? (await getPool())
  const r = await ej
    .request()
    .input('prov', sql.VarChar(6), prov)
    .query<Record<string, unknown>>(`
      SELECT LTRIM(RTRIM(d.TCOMP_IN_C)) AS tcompInC, d.NCOMP_IN_C AS ncompInC, d.N_RENGL_C AS nRenglC,
             LTRIM(RTRIM(c.N_COMP)) AS nComp, c.FECHA_EMIS AS fechaEmision,
             LTRIM(RTRIM(d.COD_ARTICU)) AS codArticu, d.CANTIDAD AS cantidad, d.FALTA_REM AS faltaRem,
             o.TALONARIO_OC AS talonarioOc, o.N_ORDEN_CO AS nOrdenCo, o.N_RENGL_OC AS nRenglOc,
             o.CANTIDAD - ISNULL((
               SELECT SUM(t.CANTIDAD) FROM CPA_OC_REMITO_FACTURA t
               WHERE t.TCOMP_IN_C = d.TCOMP_IN_C AND t.NCOMP_IN_C = d.NCOMP_IN_C AND t.N_RENGL_C = d.N_RENGL_C
                 AND t.N_ORDEN_CO = o.N_ORDEN_CO AND t.N_RENGL_OC = o.N_RENGL_OC
             ), 0) AS ocLibre
      FROM CPA46 d
      JOIN CPA04 c ON c.TCOMP_IN_C = d.TCOMP_IN_C AND c.NCOMP_IN_C = d.NCOMP_IN_C
      OUTER APPLY (
        SELECT TOP 1 f.TALONARIO_OC, f.N_ORDEN_CO, f.N_RENGL_OC, f.CANTIDAD
        FROM CPA_OC_FACTURA f
        WHERE f.TCOMP_IN_C = d.TCOMP_IN_C AND f.NCOMP_IN_C = d.NCOMP_IN_C AND f.N_RENGL_C = d.N_RENGL_C
        ORDER BY f.ID_CPA_OC_FACTURA
      ) o
      WHERE d.TCOMP_IN_C = 'FP' AND LTRIM(RTRIM(c.COD_PROVEE)) = @prov AND d.FALTA_REM > 0
      ORDER BY c.FECHA_EMIS, d.NCOMP_IN_C, d.N_RENGL_C`)

  return r.recordset.map((x) => ({
    tcompInC: String(x.tcompInC),
    ncompInC: Number(x.ncompInC),
    nRenglC: Number(x.nRenglC),
    nComp: String(x.nComp),
    fechaEmision: x.fechaEmision ? new Date(x.fechaEmision as string) : null,
    codArticu: String(x.codArticu),
    cantidad: Number(x.cantidad),
    faltaRem: Number(x.faltaRem),
    oc:
      x.nOrdenCo
        ? {
            talonario: Number(x.talonarioOc) || 0,
            nOrdenCo: String(x.nOrdenCo),
            nRenglOc: Number(x.nRenglOc),
            cantidad: Math.max(0, Number(x.ocLibre)),
          }
        : null,
  }))
}

/**
 * Un renglón de factura releído dentro de la transacción del registro, con
 * bloqueo: entre la revisión y el registro otro remito pudo haberlo
 * recibido. `null` si ya no existe.
 */
export async function renglonFacturaParaRemitoEn(
  e: Ejecutor,
  ref: { tcompInC: string; ncompInC: number; nRenglC: number },
): Promise<CandidatoFactura | null> {
  const r = await e
    .request()
    .input('t', sql.VarChar(2), ref.tcompInC)
    .input('n', sql.Float, ref.ncompInC)
    .input('r', sql.Int, ref.nRenglC)
    .query<Record<string, unknown>>(`
      SELECT LTRIM(RTRIM(c.N_COMP)) AS nComp, c.FECHA_EMIS AS fechaEmision, LTRIM(RTRIM(c.COD_PROVEE)) AS codProvee,
             LTRIM(RTRIM(d.COD_ARTICU)) AS codArticu, d.CANTIDAD AS cantidad, d.FALTA_REM AS faltaRem,
             d.PRECIO_NET AS precioNet,
             o.TALONARIO_OC AS talonarioOc, o.N_ORDEN_CO AS nOrdenCo, o.N_RENGL_OC AS nRenglOc,
             o.CANTIDAD - ISNULL((
               SELECT SUM(t.CANTIDAD) FROM CPA_OC_REMITO_FACTURA t
               WHERE t.TCOMP_IN_C = d.TCOMP_IN_C AND t.NCOMP_IN_C = d.NCOMP_IN_C AND t.N_RENGL_C = d.N_RENGL_C
                 AND t.N_ORDEN_CO = o.N_ORDEN_CO AND t.N_RENGL_OC = o.N_RENGL_OC
             ), 0) AS ocLibre
      FROM CPA46 d WITH (UPDLOCK)
      JOIN CPA04 c ON c.TCOMP_IN_C = d.TCOMP_IN_C AND c.NCOMP_IN_C = d.NCOMP_IN_C
      OUTER APPLY (
        SELECT TOP 1 f.TALONARIO_OC, f.N_ORDEN_CO, f.N_RENGL_OC, f.CANTIDAD
        FROM CPA_OC_FACTURA f
        WHERE f.TCOMP_IN_C = d.TCOMP_IN_C AND f.NCOMP_IN_C = d.NCOMP_IN_C AND f.N_RENGL_C = d.N_RENGL_C
        ORDER BY f.ID_CPA_OC_FACTURA
      ) o
      WHERE d.TCOMP_IN_C = @t AND d.NCOMP_IN_C = @n AND d.N_RENGL_C = @r`)
  const x = r.recordset[0]
  if (!x) return null
  return {
    tcompInC: ref.tcompInC,
    ncompInC: ref.ncompInC,
    nRenglC: ref.nRenglC,
    nComp: String(x.nComp),
    fechaEmision: x.fechaEmision ? new Date(x.fechaEmision as string) : null,
    codArticu: String(x.codArticu),
    cantidad: Number(x.cantidad),
    faltaRem: Number(x.faltaRem),
    precioNet: Number(x.precioNet ?? 0),
    oc: x.nOrdenCo
      ? {
          talonario: Number(x.talonarioOc) || 0,
          nOrdenCo: String(x.nOrdenCo),
          nRenglOc: Number(x.nRenglOc),
          cantidad: Math.max(0, Number(x.ocLibre)),
        }
      : null,
  }
}

/** El proveedor de una factura, para no vincular un remito a la de otro. */
export async function proveedorDeFacturaEn(
  e: Ejecutor,
  ref: { tcompInC: string; ncompInC: number },
): Promise<string | null> {
  const r = await e
    .request()
    .input('t', sql.VarChar(2), ref.tcompInC)
    .input('n', sql.Float, ref.ncompInC)
    .query(`SELECT LTRIM(RTRIM(COD_PROVEE)) AS prov FROM CPA04 WHERE TCOMP_IN_C = @t AND NCOMP_IN_C = @n`)
  return r.recordset[0]?.prov ?? null
}
