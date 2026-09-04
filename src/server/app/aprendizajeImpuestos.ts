import sql from 'mssql'
import { getPool } from '../db/pool'
import { usuarioActual } from '@/lib/usuario'
import { parsearImporte } from '@/lib/formato'
import { normalizar as normalizarJurisdiccion } from '@/lib/percepcionIibb'
import { normalizarTextoCondicion } from '@/server/tango/condicionesCompra'

type Ejecutor = { request(): sql.Request }

/**
 * Los cuatro tipos de dato que hoy pueden aprenderse por proveedor. Las
 * alícuotas de IVA se identifican por porcentaje, las percepciones de
 * Ingresos Brutos por jurisdicción, la condición de compra por el texto
 * de condición de pago/venta que imprime el proveedor, y el punto de venta
 * por el tipo de comprobante -- ver el comentario de
 * `PHF_ALICUOTA_PROVEEDOR` en `scripts/migrate.ts` (el nombre de la tabla
 * quedó corto desde que 'condicion' no es una alícuota, pero el mecanismo
 * -- MERGE por proveedor+tipo+texto -- es el mismo). Los impuestos varios
 * quedan afuera: hoy la IA no captura un texto propio para esa línea, solo
 * el código que ya elige el operador de una lista -- no hay "cómo lo
 * escribe la factura" que guardar todavía.
 *
 * 'ptovta' es el único que no se identifica por algo impreso en el
 * comprobante, porque no hay nada que leer: una liquidación de tarjeta no
 * trae punto de venta (ver el prompt de tarjeta), y sin embargo Tango
 * necesita uno para armar el N_COMP. Lo que se aprende es la convención
 * con la que el operador viene archivando a ese proveedor -- verificado
 * contra CPA04: VALLE FERTIL y el Banco de Santiago del Estero usan
 * '00000', pero el Banco Macro usa '10077', su propio código de proveedor.
 * Por eso no puede ser una constante de la app: es dato de cada proveedor.
 *
 * 'gravado' es el otro que no resuelve un codigo de Tango sino un si/no:
 * guarda, por proveedor y por rotulo de cargo ("Arancel de ley", "Costo
 * financiero"), si ese cargo suma al neto gravado. El operador lo destilda
 * una vez y las liquidaciones siguientes de esa misma procesadora ya salen
 * bien, que es lo unico que hace falta porque cada procesadora mantiene su
 * formato mes a mes. `COD_TANGO` guarda 'S' o 'N'.
 */
export type TipoAprendizaje = 'iva' | 'percepcion' | 'condicion' | 'ptovta' | 'gravado'

/**
 * Deja la `DESCRIPCION` de la tabla en la misma forma con la que después
 * se busca (`resolverCodigoIva`/`resolverPercepcionIibb`/
 * `resolverCondicionCompraEn`), para que una fila aprendida con una
 * grafía de la factura ("21,00%", "Tucumán ", "CUENTA CORRIENTE") haga
 * match con la próxima aunque venga escrita distinto.
 */
function normalizarDescripcion(tipo: TipoAprendizaje, descripcion: string): string {
  if (tipo === 'iva') return String(parsearImporte(descripcion))
  if (tipo === 'percepcion') return normalizarJurisdiccion(descripcion)
  // En 'ptovta' la descripcion es la clave de un TipoFactura ('tarjeta'),
  // no un texto de la factura: ya viene canonica, solo se le sacan los
  // espacios. Pasarla por normalizarTextoCondicion daria lo mismo hoy,
  // pero ataria la clave a las reglas de otro tipo de dato.
  if (tipo === 'ptovta') return descripcion.trim()
  // En 'gravado' la descripcion es el rotulo del cargo tal como lo imprime
  // la procesadora ("Arancel de ley", "Costo financiero"). Se normaliza
  // igual que la condicion de compra --sin acentos, minusculas, espacios
  // colapsados-- para que "Comisión" y "COMISION" sean el mismo cargo.
  return normalizarTextoCondicion(descripcion)
}

/**
 * Graba (o actualiza) que el proveedor `codProvee` identifica el impuesto
 * `descripcion` con el código de Tango `codTango`. Es la contraparte de
 * `cargarAprendidosEn`: entre las dos arman la memoria que la resolución
 * de IVA/IIBB consulta cuando el porcentaje o la jurisdicción no le
 * alcanzan.
 *
 * `MERGE` por `(COD_PROVEE, TIPO, DESCRIPCION)`, la misma clave que el
 * índice único de la tabla: una segunda corrección para el mismo texto
 * reemplaza a la primera, no agrega una fila nueva -- si el proveedor
 * cambió de la vez pasada, se queda con lo último que dijo el operador.
 */
export async function aprenderImpuestoEn(
  e: Ejecutor,
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  const prov = codProvee.trim()
  const cod = codTango.trim()
  // Se chequea la descripcion cruda antes de normalizar: "" normaliza a
  // "0" en 'iva' (parsearImporte('') es 0), un string no vacio que
  // pasaria el chequeo si se mirara despues de normalizar.
  if (!prov || !descripcion.trim() || !cod) return
  const desc = normalizarDescripcion(tipo, descripcion)
  if (!desc) return

  await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('tipo', sql.VarChar(20), tipo)
    .input('desc', sql.NVarChar(200), desc)
    .input('cod', sql.VarChar(10), cod)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      MERGE PHF_ALICUOTA_PROVEEDOR WITH (HOLDLOCK) AS destino
      USING (SELECT @prov AS COD_PROVEE, @tipo AS TIPO, @desc AS DESCRIPCION) AS origen
        ON destino.COD_PROVEE = origen.COD_PROVEE
       AND destino.TIPO = origen.TIPO
       AND destino.DESCRIPCION = origen.DESCRIPCION
      WHEN MATCHED THEN
        UPDATE SET COD_TANGO = @cod, FECHA_MODIF = SYSDATETIME(), USUARIO = @usuario
      WHEN NOT MATCHED THEN
        INSERT (COD_PROVEE, TIPO, DESCRIPCION, COD_TANGO, USUARIO)
        VALUES (@prov, @tipo, @desc, @cod, @usuario);
    `)
}

export async function aprenderImpuesto(
  codProvee: string,
  tipo: TipoAprendizaje,
  descripcion: string,
  codTango: string,
): Promise<void> {
  await aprenderImpuestoEn(await getPool(), codProvee, tipo, descripcion, codTango)
}

/**
 * Todo lo que este proveedor ya enseñó para `tipo`, como
 * `{ descripcionNormalizada: codTango }`. Un objeto plano y no un `Map`
 * porque cruza la frontera server/client component (los props de un
 * Server Component no pueden llevar `Map`), y porque `resolverCodigoIva`/
 * `resolverPercepcionIibb` ya reciben `valores` de la misma forma.
 */
export async function cargarAprendidosEn(
  e: Ejecutor,
  codProvee: string,
  tipo: TipoAprendizaje,
): Promise<Record<string, string>> {
  const prov = codProvee.trim()
  const mapa: Record<string, string> = {}
  if (!prov) return mapa

  const r = await e
    .request()
    .input('prov', sql.VarChar(20), prov)
    .input('tipo', sql.VarChar(20), tipo)
    .query<Record<string, unknown>>(`
      SELECT DESCRIPCION, COD_TANGO FROM PHF_ALICUOTA_PROVEEDOR
      WHERE COD_PROVEE = @prov AND TIPO = @tipo
    `)
  for (const f of r.recordset) {
    mapa[String(f.DESCRIPCION)] = String(f.COD_TANGO).trim()
  }
  return mapa
}

export async function cargarAprendidos(
  codProvee: string,
  tipo: TipoAprendizaje,
): Promise<Record<string, string>> {
  return cargarAprendidosEn(await getPool(), codProvee, tipo)
}
