import sql from 'mssql'
import { usuarioActual } from '@/lib/usuario'
import { leerArchivoArca, interpretarFilas, tipoArca, type ComprobanteArca } from '@/lib/arca'
import { filasDesdeXlsx } from './arcaXlsx'
import {
  conciliar,
  resumir,
  type FilaArca,
  type ResultadoFila,
  type EstadoConciliacion,
} from '@/lib/conciliacion'
import { comprobantesParaConciliar } from '@/server/tango/conciliacion'

type Ejecutor = { request(): sql.Request }

/**
 * La importación del archivo "Mis Comprobantes" de ARCA y el cruce contra
 * Tango (2026-10-09, pedido del usuario).
 *
 * Las tablas propias son `PHF_ARCA_IMPORTACION` y `PHF_ARCA_COMPROBANTE`;
 * lo de Tango se lee por `server/tango/conciliacion.ts`, que es la única
 * capa que toca el ERP.
 */

export type ResumenImportacion = {
  importacionId: number
  filas: number
  /** Las que el archivo traía y no se pudieron interpretar. */
  ignoradas: number
  desde: Date | null
  hasta: Date | null
}

/**
 * Cuántas filas entran por INSERT. El driver corta a los 2.100 parámetros
 * por request y cada comprobante usa once, así que 150 deja margen.
 */
const POR_LOTE = 150

/** Un XLSX es un ZIP: los dos primeros bytes son "PK". */
function esZip(b: Buffer): boolean {
  return b.length > 1 && b[0] === 0x50 && b[1] === 0x4b
}

/** Convierte la hoja a filas, o lanza con el motivo. */
async function filasOExplotar(datos: Buffer): Promise<string[][]> {
  const r = await filasDesdeXlsx(datos)
  if (!r.ok) throw new Error(r.error)
  return r.filas
}

/**
 * Guarda el archivo. REEMPLAZA lo anterior: la conciliación se mira contra
 * una sola foto de ARCA, y acumular importaciones dejaría el mismo
 * comprobante informado dos veces. Volver a subir el mismo período es la
 * forma normal de corregir, así que tiene que ser idempotente.
 */
export async function importarArcaEn(
  e: Ejecutor,
  archivoNombre: string,
  contenido: string | Buffer,
): Promise<ResumenImportacion> {
  // XLSX o CSV: lo decide el CONTENIDO, no la extension. Un archivo que
  // alguien renombro a .csv pero sigue siendo un Excel tiene que leerse
  // igual, y uno que es texto no gana nada pasando por exceljs. Los XLSX
  // son ZIP, asi que empiezan con "PK".
  const leido = Buffer.isBuffer(contenido) && esZip(contenido)
    ? interpretarFilas(await filasOExplotar(contenido))
    : leerArchivoArca(contenido.toString())
  if (!leido.ok) throw new Error(leido.error)

  const fechas = leido.comprobantes.map((c) => c.fechaEmision.getTime())
  const desde = new Date(Math.min(...fechas))
  const hasta = new Date(Math.max(...fechas))

  // Una sola importación vigente por vez.
  await e.request().query('DELETE FROM PHF_ARCA_IMPORTACION')

  const alta = await e
    .request()
    .input('nombre', sql.NVarChar(260), archivoNombre.slice(0, 260))
    .input('desde', sql.Date, desde)
    .input('hasta', sql.Date, hasta)
    .input('filas', sql.Int, leido.comprobantes.length)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query<{ ID: number }>(`
      INSERT INTO PHF_ARCA_IMPORTACION
        (ARCHIVO_NOMBRE, PERIODO_DESDE, PERIODO_HASTA, FILAS, USUARIO)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @desde, @hasta, @filas, @usuario)
    `)
  const importacionId = Number(alta.recordset[0].ID)

  for (let i = 0; i < leido.comprobantes.length; i += POR_LOTE) {
    await insertarLote(e, importacionId, leido.comprobantes.slice(i, i + POR_LOTE))
  }

  return {
    importacionId,
    filas: leido.comprobantes.length,
    ignoradas: leido.ignoradas,
    desde,
    hasta,
  }
}

async function insertarLote(
  e: Ejecutor,
  importacionId: number,
  lote: ComprobanteArca[],
): Promise<void> {
  const req = e.request().input('imp', sql.Int, importacionId)
  const valores = lote.map((c, i) => {
    req
      .input(`f${i}`, sql.Date, c.fechaEmision)
      .input(`tc${i}`, sql.Int, c.tipoCodigo)
      .input(`tl${i}`, sql.VarChar(2), c.letra)
      .input(`pv${i}`, sql.Int, c.puntoVenta)
      .input(`nr${i}`, sql.BigInt, c.numero)
      .input(`cu${i}`, sql.VarChar(15), c.cuitEmisor)
      .input(`rz${i}`, sql.NVarChar(200), c.razonEmisor?.slice(0, 200) ?? null)
      .input(`it${i}`, sql.Decimal(19, 4), c.importeTotal)
      .input(`in${i}`, sql.Decimal(19, 4), c.importeNeto)
      .input(`ii${i}`, sql.Decimal(19, 4), c.importeIva)
    return `(@imp, @f${i}, @tc${i}, @tl${i}, @pv${i}, @nr${i}, @cu${i}, @rz${i}, @it${i}, @in${i}, @ii${i})`
  })

  await req.query(`
    INSERT INTO PHF_ARCA_COMPROBANTE
      (IMPORTACION_ID, FECHA_EMISION, TIPO_CODIGO, TIPO_LETRA, PUNTO_VENTA, NUMERO,
       CUIT_EMISOR, RAZON_EMISOR, IMPORTE_TOTAL, IMPORTE_NETO, IMPORTE_IVA)
    VALUES ${valores.join(', ')}
  `)
}

export type Importacion = {
  id: number
  archivoNombre: string
  desde: Date | null
  hasta: Date | null
  filas: number
  fechaAlta: Date
  usuario: string
}

export async function importacionVigenteEn(e: Ejecutor): Promise<Importacion | null> {
  const r = await e.request().query<Record<string, unknown>>(`
    SELECT TOP 1 ID, ARCHIVO_NOMBRE, PERIODO_DESDE, PERIODO_HASTA, FILAS, FECHA_ALTA, USUARIO
    FROM PHF_ARCA_IMPORTACION ORDER BY ID DESC
  `)
  const x = r.recordset[0]
  if (!x) return null
  return {
    id: Number(x.ID),
    archivoNombre: String(x.ARCHIVO_NOMBRE),
    desde: x.PERIODO_DESDE ? new Date(x.PERIODO_DESDE as string) : null,
    hasta: x.PERIODO_HASTA ? new Date(x.PERIODO_HASTA as string) : null,
    filas: Number(x.FILAS),
    fechaAlta: new Date(x.FECHA_ALTA as string),
    usuario: String(x.USUARIO),
  }
}

async function filasArcaEn(e: Ejecutor, importacionId: number): Promise<FilaArca[]> {
  const r = await e
    .request()
    .input('imp', sql.Int, importacionId)
    .query<Record<string, unknown>>(`
      SELECT ID, FECHA_EMISION, TIPO_CODIGO, TIPO_LETRA, PUNTO_VENTA, NUMERO,
             CUIT_EMISOR, RAZON_EMISOR, IMPORTE_TOTAL
      FROM PHF_ARCA_COMPROBANTE WHERE IMPORTACION_ID = @imp
      ORDER BY FECHA_EMISION, ID
    `)

  return r.recordset.map((x) => ({
    id: Number(x.ID),
    fechaEmision: new Date(x.FECHA_EMISION as string),
    letra: x.TIPO_LETRA ? String(x.TIPO_LETRA) : null,
    clase: claseDeCodigo(Number(x.TIPO_CODIGO)),
    puntoVenta: Number(x.PUNTO_VENTA),
    numero: Number(x.NUMERO),
    cuitEmisor: String(x.CUIT_EMISOR),
    razonEmisor: x.RAZON_EMISOR ? String(x.RAZON_EMISOR) : null,
    importeTotal: Number(x.IMPORTE_TOTAL),
  }))
}

/**
 * La clase se recalcula desde el código de ARCA, que es el dato oficial y
 * es lo que se guardó. No se guarda la clase: derivarla de la fuente evita
 * que una fila vieja quede con una clasificación que después cambió.
 */
function claseDeCodigo(codigo: number): FilaArca['clase'] {
  return tipoArca(codigo)?.clase ?? 'otro'
}

export type ResultadoConciliacion = {
  importacion: Importacion | null
  filas: ResultadoFila[]
  resumen: Record<EstadoConciliacion, number>
}

/**
 * El cruce completo. Trae las dos listas enteras y las empareja en memoria:
 * son ~17.500 filas de Tango (184 ms de consulta, medido) y las que traiga
 * el archivo, así que no hace falta hacerlo contra la base.
 */
export async function conciliarEn(e: Ejecutor): Promise<ResultadoConciliacion> {
  const importacion = await importacionVigenteEn(e)
  if (!importacion) {
    return {
      importacion: null,
      filas: [],
      resumen: { coincide: 0, 'falta-en-tango': 0, 'falta-en-arca': 0, difiere: 0 },
    }
  }

  const [arca, tango] = await Promise.all([
    filasArcaEn(e, importacion.id),
    comprobantesParaConciliar(),
  ])

  const filas = conciliar(arca, tango, { desde: importacion.desde, hasta: importacion.hasta })
  return { importacion, filas, resumen: resumir(filas) }
}
