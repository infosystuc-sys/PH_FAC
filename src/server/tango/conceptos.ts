import sql from 'mssql'
import { getPool } from '../db/pool'
import { tieneColumna } from './esquema'

export type ConceptoProveedor = { codConcepto: string; descripcion: string }

/**
 * CPA_CONCEPTOS_PROVEEDOR es 1:1 por proveedor en toda la base hoy (ningun
 * COD_PROVEE tiene mas de una fila) -- no hace falta manejar ambiguedad como
 * con las percepciones de Fase 4. ID_CPA45 enlaza al maestro de conceptos
 * (CPA45), de donde sale la descripcion para mostrarle al operador cual
 * concepto se va a grabar, no solo el codigo.
 */
export async function buscarConceptoProveedor(codProvee: string): Promise<ConceptoProveedor | null> {
  const cod = codProvee.trim()
  if (!cod) return null

  const pool = await getPool()
  // Las bases mas viejas no tienen ID_CPA45 en la tabla: ahi se une por codigo.
  const unir = (await tieneColumna('CPA_CONCEPTOS_PROVEEDOR', 'ID_CPA45'))
    ? 'c.ID_CPA45 = cp.ID_CPA45'
    : 'LTRIM(RTRIM(c.COD_CONCEP)) COLLATE DATABASE_DEFAULT = LTRIM(RTRIM(cp.COD_CONCEPT)) COLLATE DATABASE_DEFAULT'
  const r = await pool
    .request()
    .input('cod', sql.VarChar(6), cod)
    .query(`
      SELECT cp.COD_CONCEPT AS codConcepto, LTRIM(RTRIM(ISNULL(c.DESC_CONCE,''))) AS descripcion
      FROM CPA_CONCEPTOS_PROVEEDOR cp
      LEFT JOIN CPA45 c ON ${unir}
      WHERE cp.COD_PROVEE = @cod
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return { codConcepto: String(row.codConcepto).trim(), descripcion: String(row.descripcion) }
}

/**
 * Todo el maestro de conceptos, para que el operador elija uno a mano
 * cuando el proveedor no tiene ninguno asociado. Solo código y descripción
 * -- el resto de CPA45 (IVA, costo, clasificación SIAP) es configuración
 * interna de Tango que no le compete elegir desde acá.
 *
 * Se trae completo (89 filas hoy) en vez de con búsqueda server-side como
 * `buscarArticulos`: a esta escala un filtro en el cliente alcanza y evita
 * un round-trip por cada letra que el operador tipea.
 */
export async function listarConceptos(): Promise<ConceptoProveedor[]> {
  const pool = await getPool()
  const r = await pool.request().query(`
    SELECT LTRIM(RTRIM(COD_CONCEP)) AS codConcepto,
           LTRIM(RTRIM(ISNULL(DESC_CONCE,''))) AS descripcion
    FROM CPA45
    WHERE ISNULL(INHABILITA,0) = 0
    ORDER BY DESC_CONCE
  `)
  return r.recordset.map((x) => ({
    codConcepto: String(x.codConcepto),
    descripcion: String(x.descripcion),
  }))
}

/**
 * El operador asocia a mano un concepto al proveedor, cuando la ficha no
 * trae ninguno. Escribe `CPA_CONCEPTOS_PROVEEDOR` -- la misma tabla que lee
 * `buscarConceptoProveedor` -- para que la próxima factura de este
 * proveedor ya lo encuentre resuelto.
 *
 * MERGE por `COD_PROVEE` solo, no por `(COD_PROVEE, COD_CONCEPT)` -- que es
 * lo que permite el índice único de la tabla --: la app entera asume una
 * relación 1:1 por proveedor (verificado contra la base real, ningún
 * `COD_PROVEE` tiene hoy más de una fila), así que elegir un concepto
 * distinto reemplaza al anterior en vez de agregar una segunda fila que
 * dejaría a `buscarConceptoProveedor` con un resultado ambiguo.
 *
 * `ID_CPA_CONCEPTOS_PROVEEDOR` se omite del INSERT a propósito, mismo
 * criterio que `ID_CPA15` en `asociarArticuloProveedor`: su default es
 * `NEXT VALUE FOR [SEQUENCE_CPA_CONCEPTOS_PROVEEDOR]`.
 */
export async function asignarConceptoProveedor(
  codProvee: string,
  codConcepto: string,
): Promise<void> {
  const prov = codProvee.trim()
  const concepto = codConcepto.trim()
  if (!prov || !concepto) return

  const pool = await getPool()
  // Las bases mas viejas no tienen las claves ID_CPA45 / ID_CPA01: ahi se
  // graba solo el par de codigos.
  const conIds = await tieneColumna('CPA_CONCEPTOS_PROVEEDOR', 'ID_CPA45')
  const actualizarIds = conIds
    ? `, ID_CPA45 = (SELECT ID_CPA45 FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @concepto)`
    : ''
  const columnasIds = conIds ? ', ID_CPA45, ID_CPA01' : ''
  const valoresIds = conIds
    ? `,
          (SELECT ID_CPA45 FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @concepto),
          (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE = @prov)`
    : ''
  await pool
    .request()
    .input('prov', sql.VarChar(6), prov)
    .input('concepto', sql.VarChar(3), concepto)
    .query(`
      MERGE CPA_CONCEPTOS_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE) AS origen
        ON LTRIM(RTRIM(destino.COD_PROVEE)) = origen.COD_PROVEE
      WHEN MATCHED THEN
        UPDATE SET COD_CONCEPT = @concepto${actualizarIds}
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, COD_CONCEPT${columnasIds})
        VALUES (
          @prov, @concepto${valoresIds}
        );
    `)
}

/**
 * El concepto al que van TODAS las liquidaciones de tarjeta: 406,
 * "COMISIONES TARJETAS DE CREDITO" (decision del usuario, 2026-08-16).
 *
 * Va fijo y no sale de la ficha del proveedor como en las facturas de
 * conceptos. La razon es que el proveedor de una liquidacion es la
 * tarjeta o el banco -- VISA, Naranja, Mastercard --, y su ficha suele
 * tener otro concepto o ninguno; lo que se imputa siempre es la comision,
 * sin importar quien la cobre.
 */
export const COD_CONCEPTO_TARJETA = '406'

/**
 * Lee del maestro la descripcion del concepto fijo de tarjeta, para
 * mostrarsela al operador con el mismo formato que la del proveedor.
 *
 * No se hardcodea la descripcion junto al codigo: si en Tango la renombran,
 * la pantalla tiene que decir lo que dice Tango. Si el concepto no existe
 * devuelve null y quien llama decide -- para el registro eso es un error,
 * porque el INSERT a CPA47 iria contra un codigo inexistente.
 */
export async function buscarConceptoTarjeta(): Promise<ConceptoProveedor | null> {
  return buscarConceptoPorCodigo(COD_CONCEPTO_TARJETA)
}

/** Un concepto del maestro (CPA45) por su codigo, o null si no existe. */
export async function buscarConceptoPorCodigo(codConcepto: string): Promise<ConceptoProveedor | null> {
  const cod = codConcepto.trim()
  if (!cod) return null
  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(3), cod)
    .query(`
      SELECT LTRIM(RTRIM(COD_CONCEP)) AS codConcepto,
             LTRIM(RTRIM(ISNULL(DESC_CONCE,''))) AS descripcion
      FROM CPA45 WHERE LTRIM(RTRIM(COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return { codConcepto: String(row.codConcepto), descripcion: String(row.descripcion) }
}

/**
 * El concepto que le corresponde a un comprobante segun su tipo: el de la
 * ficha del proveedor en las facturas de conceptos, el fijo de comisiones
 * en las liquidaciones de tarjeta, y ninguno en las de articulos (esas se
 * imputan por renglon).
 *
 * Existe para que la pantalla de revision, la validacion y el registro
 * resuelvan el concepto por el mismo camino y no puedan discrepar.
 *
 * `elegido` es el concepto que el operador eligio para ESTE comprobante
 * (campo `concepto` de la revision), desde el 2026-09-17 a pedido del
 * usuario: gana sobre la ficha del proveedor sin modificarla. Es la misma
 * precedencia que en las alicuotas -- correccion del comprobante > lo del
 * proveedor -- y por el mismo motivo: un proveedor puede facturar una vez
 * algo distinto de lo habitual, y cambiarle la ficha por esa vez dejaria
 * mal las que vienen. Solo aplica en conceptos: en tarjeta el concepto es
 * fijo, y en articulos no hay.
 */
export async function conceptoDelComprobante(
  tipoFactura: string | null | undefined,
  codProvee: string | null,
  elegido?: string | null,
): Promise<ConceptoProveedor | null> {
  if (tipoFactura === 'tarjeta') return buscarConceptoTarjeta()
  if (tipoFactura === 'conceptos') {
    const propio = (elegido ?? '').trim()
    if (propio) return buscarConceptoPorCodigo(propio)
    return codProvee ? buscarConceptoProveedor(codProvee) : null
  }
  return null
}
