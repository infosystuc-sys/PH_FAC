import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { extraerDePdf, type Extraccion } from '../ia/extraccion'
import { buscarProveedorPorCuit } from '../tango/proveedores'
import { normalizarCuit } from '@/lib/formato'
import { guardarExtraccionEn, guardarCampoEn, auditarEn } from './detalle'
import { leerPdf } from './archivos'

export const MAX_INTENTOS = 3
export const MINUTOS_REPESCA = 10
export const CONCURRENCIA = 3
const INTERVALO_MS = 2 * 60 * 1000

type Ejecutor = { request(): sql.Request }

export type Pendiente = { id: number; ruta: string }

/**
 * Los comprobantes que hay que extraer: los recien encolados y los que
 * quedaron colgados en `procesando`. Un comprobante queda colgado cuando
 * el server se reinicia o se cae en medio de la extraccion; sin la
 * repesca se quedaria ahi para siempre.
 *
 * La ventana de repesca se mide contra FECHA_MODIF, que se toca en cada
 * intento, y no contra FECHA_ALTA: si no, un comprobante en su tercer
 * intento se repescaria de inmediato.
 */
export async function tomarPendientesEn(e: Ejecutor, limite: number): Promise<Pendiente[]> {
  const r = await e
    .request()
    .input('lim', sql.Int, limite)
    .input('max', sql.Int, MAX_INTENTOS)
    .input('min', sql.Int, MINUTOS_REPESCA)
    .query<Record<string, unknown>>(`
      SELECT TOP (@lim) ID, ARCHIVO_RUTA
      FROM PHF_COMPROBANTE
      WHERE ESTADO = 'procesando'
        AND INTENTOS < @max
        AND (FECHA_MODIF IS NULL OR FECHA_MODIF < DATEADD(MINUTE, -@min, SYSDATETIME()))
      ORDER BY FECHA_ALTA
    `)

  return r.recordset.map((x) => ({ id: Number(x.ID), ruta: String(x.ARCHIVO_RUTA) }))
}

export async function marcarLeidoEn(
  e: Ejecutor,
  id: number,
  confianzaPromedio: number,
  ms: number,
  modelo: string,
  campos: number,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('conf', sql.Decimal(5, 4), confianzaPromedio)
    .input('ms', sql.Int, ms)
    .input('modelo', sql.VarChar(40), modelo)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'leido',
          CONFIANZA_PROMEDIO = @conf,
          EXTRACCION_MS = @ms,
          EXTRACCION_MODELO = @modelo,
          ERROR_MENSAJE = NULL,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  const seg = (ms / 1000).toFixed(1).replace('.', ',')
  await auditarEn(e, id, `Lectura automática con IA — ${campos} campos en ${seg} s`)
}

/**
 * Suma un intento. Si quedan reintentos lo deja en `procesando` para que
 * la repesca lo vuelva a tomar; si se agotaron, lo pasa a `error`.
 */
export async function marcarFalloEn(e: Ejecutor, id: number, error: string): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('err', sql.NVarChar(1000), error.slice(0, 1000))
    .input('max', sql.Int, MAX_INTENTOS)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET INTENTOS = INTENTOS + 1,
          ERROR_MENSAJE = @err,
          ESTADO = CASE WHEN INTENTOS + 1 >= @max THEN 'error' ELSE 'procesando' END,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(e, id, `Falló la lectura automática: ${error}`.slice(0, 500))
}

/**
 * Copia a las columnas de `PHF_COMPROBANTE` los campos que la bandeja
 * muestra. Sin esto la bandeja quedaría con las columnas vacías: la
 * bandeja lee de la tabla, no de PHF_CAMPO, para no hacer 21 joins por
 * fila con 100 comprobantes en pantalla.
 *
 * El total y la fecha se convierten acá porque las columnas son
 * DECIMAL(19,4) y DATE. `TRY_CONVERT` deja NULL si la IA leyó algo que no
 * parsea, en vez de hacer fallar toda la extracción por un campo.
 */
export async function desnormalizarBandejaEn(
  e: Ejecutor,
  id: number,
  extraccion: Extraccion,
): Promise<void> {
  const v = (clave: string) => extraccion.campos[clave]?.valor ?? null

  await e
    .request()
    .input('id', sql.Int, id)
    .input('tipo', sql.VarChar(10), v('tipo')?.slice(0, 10) ?? null)
    .input('pv', sql.VarChar(10), v('ptovta')?.slice(0, 10) ?? null)
    .input('nro', sql.VarChar(20), v('nro')?.slice(0, 20) ?? null)
    .input('cuit', sql.VarChar(15), v('cuit')?.slice(0, 15) ?? null)
    .input('total', sql.NVarChar(50), v('total'))
    .input('fecha', sql.NVarChar(20), v('fecha'))
    .query(`
      UPDATE PHF_COMPROBANTE
      SET TIPO = @tipo,
          PUNTO_VENTA = @pv,
          NUMERO = @nro,
          CUIT = @cuit,
          TOTAL = TRY_CONVERT(DECIMAL(19,4), REPLACE(REPLACE(@total, '.', ''), ',', '.')),
          FECHA_EMISION = TRY_CONVERT(DATE, @fecha, 103)
      WHERE ID = @id
    `)
}

/**
 * Busca el proveedor de Tango por el CUIT que leyó la IA y deja el código
 * en el campo `codprovee` y en la columna de bandeja. Si no matchea, no
 * escribe nada: la validación bloqueante y la resolución de CUIT
 * duplicados son de la Fase 3.
 *
 * Es el único punto de la app fuera de src/server/tango/ que necesita un
 * dato del ERP, y lo pide por la función de esa capa: no emite SQL contra
 * CPA01 ni la nombra.
 */
export async function resolverProveedorEn(
  e: Ejecutor,
  id: number,
  cuit: string | null,
): Promise<void> {
  if (!cuit || !normalizarCuit(cuit)) return

  const proveedor = await buscarProveedorPorCuit(cuit)
  if (!proveedor) return

  await guardarCampoEn(e, id, 'codprovee', proveedor.codProvee)

  await e
    .request()
    .input('id', sql.Int, id)
    .input('cod', sql.VarChar(20), proveedor.codProvee)
    .input('razon', sql.NVarChar(200), proveedor.razonSocial)
    .query(`
      UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cod, RAZON_SOCIAL = @razon WHERE ID = @id
    `)
}

/** Extrae un comprobante y deja el resultado en la base. No lanza. */
export async function procesarUno({ id, ruta }: Pendiente): Promise<void> {
  try {
    const pdf = await leerPdf(ruta)
    const r = await extraerDePdf(pdf)

    if (!r.ok) {
      await conTransaccion((tx) => marcarFalloEn(tx, id, r.error))
      return
    }

    await conTransaccion(async (tx) => {
      const prom = await guardarExtraccionEn(tx, id, r.extraccion)
      await desnormalizarBandejaEn(tx, id, r.extraccion)
      await resolverProveedorEn(tx, id, r.extraccion.campos.cuit?.valor ?? null)
      const conValor = Object.values(r.extraccion.campos).filter((c) => c.valor !== null).length
      await marcarLeidoEn(tx, id, prom, r.ms, r.modelo, conValor)
    })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    await conTransaccion((tx) => marcarFalloEn(tx, id, mensaje)).catch(() => {})
  }
}

let corriendo = false
let temporizador: ReturnType<typeof setInterval> | null = null

async function tanda(): Promise<void> {
  if (corriendo) return
  corriendo = true
  try {
    const pendientes = await tomarPendientesEn(await getPool(), CONCURRENCIA)
    await Promise.all(pendientes.map(procesarUno))
  } catch {
    // Si la base no responde, la proxima tanda reintenta.
  } finally {
    corriendo = false
  }
}

/**
 * Worker en proceso. Es suficiente para una app de red interna con un
 * operador. Si en algun momento hay mas de una instancia, `tomarPendientes`
 * necesita un lock para que dos no tomen el mismo comprobante.
 */
export function arrancarWorker(): void {
  if (temporizador) return
  temporizador = setInterval(() => void tanda(), INTERVALO_MS)
  void tanda()
}

/** Despierta al worker sin esperar al intervalo. Se llama al importar. */
export function despertarWorker(): void {
  void tanda()
}
