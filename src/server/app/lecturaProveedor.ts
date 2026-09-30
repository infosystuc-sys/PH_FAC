import sql from 'mssql'
import { usuarioActual } from '@/lib/usuario'
import {
  esEscalaLectura,
  debeReemplazar,
  type EscalaLectura,
  type ReglaLectura,
} from '@/lib/lecturaProveedor'

type Ejecutor = { request(): sql.Request }

/**
 * La forma en que la app lee las facturas de cada proveedor
 * (`PHF_LECTURA_PROVEEDOR`).
 *
 * Es una tabla propia y no un sinónimo de Tango a propósito: lo que se
 * guarda no es una equivalencia entre códigos --para eso está CPA15-- sino
 * cómo está repartido el código en el papel de ese proveedor. Tango no
 * tiene dónde anotar eso.
 */

function aRegla(row: Record<string, unknown>): ReglaLectura | null {
  const escala = String(row.ESCALA ?? '')
  if (!esEscalaLectura(escala)) return null
  return {
    codProvee: String(row.COD_PROVEE ?? '').trim(),
    escala,
    comprobantes: Number(row.COMPROBANTES ?? 0),
    manual: Boolean(row.MANUAL),
  }
}

export async function reglaDeProveedorEn(
  e: Ejecutor,
  codProvee: string | null,
): Promise<ReglaLectura | null> {
  const prov = (codProvee ?? '').trim()
  if (!prov) return null
  const r = await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .query<Record<string, unknown>>(
      `SELECT COD_PROVEE, ESCALA, COMPROBANTES, MANUAL
       FROM PHF_LECTURA_PROVEEDOR WHERE COD_PROVEE = @prov`,
    )
  const row = r.recordset[0]
  return row ? aRegla(row) : null
}

/** Todas las reglas aprendidas, para mostrarlas juntas en configuración. */
export async function reglasDeLecturaEn(e: Ejecutor): Promise<ReglaLectura[]> {
  const r = await e.request().query<Record<string, unknown>>(
    `SELECT COD_PROVEE, ESCALA, COMPROBANTES, MANUAL
     FROM PHF_LECTURA_PROVEEDOR ORDER BY COD_PROVEE`,
  )
  return r.recordset.map(aRegla).filter((x): x is ReglaLectura => x !== null)
}

/**
 * Guarda --o confirma-- la regla de un proveedor.
 *
 * `porOperador` distingue las dos formas en que se aprende: deducida de lo
 * que se leyó del comprobante, o elegida a mano. Una regla manual no la
 * pisa la deducción automática (ver `debeReemplazar`): si el operador la
 * eligió, conoce al proveedor mejor que lo que se puede inferir de un
 * papel.
 *
 * Cuando la regla que llega es la MISMA que ya estaba, no se reescribe: se
 * suma el contador de comprobantes, que es lo que después distingue la
 * regla que ya es costumbre del proveedor de la que se vio una sola vez.
 */
export async function guardarReglaEn(
  e: Ejecutor,
  codProvee: string | null,
  escala: EscalaLectura,
  porOperador = false,
): Promise<ReglaLectura | null> {
  const prov = (codProvee ?? '').trim()
  if (!prov) return null

  const guardada = await reglaDeProveedorEn(e, prov)
  if (guardada && !debeReemplazar(guardada, escala, porOperador)) {
    // La regla no cambia; solo se anota que se volvio a ver.
    if (guardada.escala === escala) {
      await e
        .request()
        .input('prov', sql.VarChar(20), prov)
        .query(
          `UPDATE PHF_LECTURA_PROVEEDOR
           SET COMPROBANTES = COMPROBANTES + 1, ACTUALIZADO = SYSDATETIME()
           WHERE COD_PROVEE = @prov`,
        )
      return { ...guardada, comprobantes: guardada.comprobantes + 1 }
    }
    return guardada
  }

  await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('escala', sql.VarChar(20), escala)
    .input('manual', sql.Bit, porOperador ? 1 : 0)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      MERGE PHF_LECTURA_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE) AS origen
        ON destino.COD_PROVEE = origen.COD_PROVEE
      WHEN MATCHED THEN
        UPDATE SET ESCALA = @escala, MANUAL = @manual,
                   COMPROBANTES = destino.COMPROBANTES + 1,
                   ACTUALIZADO = SYSDATETIME(), USUARIO = @usuario
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, ESCALA, COMPROBANTES, MANUAL, ACTUALIZADO, USUARIO)
        VALUES (@prov, @escala, 1, @manual, SYSDATETIME(), @usuario);
    `)

  return {
    codProvee: prov,
    escala,
    comprobantes: (guardada?.comprobantes ?? 0) + 1,
    manual: porOperador,
  }
}
