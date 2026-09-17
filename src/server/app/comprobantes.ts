import sql from 'mssql'
import { tipoPorNombre, esImagen } from '@/lib/tipoArchivo'
import { getPool } from '../db/pool'
import type { Estado, ClaveTab } from '@/lib/estados'
import { usuarioActual } from '@/lib/usuario'

export type FilaBandeja = {
  id: number
  estado: Estado
  tipo: string | null
  puntoVenta: string | null
  numero: string | null
  fechaEmision: Date | null
  razonSocial: string | null
  cuit: string | null
  total: number | null
  confianzaPromedio: number | null
}

export type Kpis = {
  pendientes: number
  enObservacion: number
  registradosHoy: number
  importePendiente: number
}

export type Conteos = Record<ClaveTab, number>

export type OpcionesListado = {
  filtro: ClaveTab
  query: string
  limite?: number
  offset?: number
}

type Ejecutor = { request(): sql.Request }

// Dos patrones distintos: el de texto conserva espacios y guiones para que
// "metalurgica del" siga matcheando la razon social; el de CUIT los saca de
// los dos lados para que "30-64872913-7" encuentre al que esta guardado sin
// guiones, y al reves.
const WHERE_BUSQUEDA = `
  (@q = ''
   OR RAZON_SOCIAL LIKE @like
   OR NUMERO LIKE @like
   OR REPLACE(REPLACE(REPLACE(ISNULL(CUIT,''), '-', ''), ' ', ''), '.', '') LIKE @likeCuit)
`

function pedido(e: Ejecutor, filtro: ClaveTab, query: string): sql.Request {
  const q = query.trim()
  return e
    .request()
    .input('q', sql.NVarChar(200), q)
    .input('like', sql.NVarChar(210), `%${q}%`)
    .input('likeCuit', sql.NVarChar(210), `%${q.replace(/[-\s.]/g, '')}%`)
    // 'vincular' no es un estado: es el corte por RENGLONES_A_VINCULAR (ver
    // estados.ts). Va como flag aparte para que @estado siga siendo NULL.
    .input('estado', sql.VarChar(20), filtro === 'todos' || filtro === 'vincular' ? null : filtro)
    .input('soloAVincular', sql.Bit, filtro === 'vincular' ? 1 : 0)
}

// Los que estan "a vincular" son los que tienen renglones sin articulo y
// todavia se pueden trabajar: una vez registrados o existentes ya no hay
// nada que vincular.
const WHERE_A_VINCULAR = `(RENGLONES_A_VINCULAR > 0 AND ESTADO NOT IN ('registrado', 'existente'))`
const WHERE_ESTADO = `(@estado IS NULL OR ESTADO = @estado) AND (@soloAVincular = 0 OR ${WHERE_A_VINCULAR})`

function aFila(row: Record<string, unknown>): FilaBandeja {
  return {
    id: Number(row.ID),
    estado: String(row.ESTADO) as Estado,
    tipo: row.TIPO ? String(row.TIPO) : null,
    puntoVenta: row.PUNTO_VENTA ? String(row.PUNTO_VENTA) : null,
    numero: row.NUMERO ? String(row.NUMERO) : null,
    fechaEmision: row.FECHA_EMISION ? new Date(row.FECHA_EMISION as string) : null,
    razonSocial: row.RAZON_SOCIAL ? String(row.RAZON_SOCIAL) : null,
    cuit: row.CUIT ? String(row.CUIT) : null,
    total: row.TOTAL === null || row.TOTAL === undefined ? null : Number(row.TOTAL),
    confianzaPromedio:
      row.CONFIANZA_PROMEDIO === null || row.CONFIANZA_PROMEDIO === undefined
        ? null
        : Number(row.CONFIANZA_PROMEDIO),
  }
}

export async function listarComprobantesEn(
  e: Ejecutor,
  { filtro, query, limite = 100, offset = 0 }: OpcionesListado,
): Promise<{ filas: FilaBandeja[]; total: number }> {
  const r = await pedido(e, filtro, query)
    .input('lim', sql.Int, limite)
    .input('off', sql.Int, offset)
    .query<Record<string, unknown>>(`
      SELECT ID, ESTADO, TIPO, PUNTO_VENTA, NUMERO, FECHA_EMISION,
             RAZON_SOCIAL, CUIT, TOTAL, CONFIANZA_PROMEDIO
      FROM PHF_COMPROBANTE
      WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
      ORDER BY FECHA_ALTA DESC, ID DESC
      OFFSET @off ROWS FETCH NEXT @lim ROWS ONLY;

      SELECT COUNT(*) AS total
      FROM PHF_COMPROBANTE
      WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA};
    `)

  return {
    filas: r.recordsets[0].map(aFila),
    total: Number((r.recordsets[1] as Record<string, unknown>[])[0].total),
  }
}

export async function listarComprobantes(opts: OpcionesListado) {
  return listarComprobantesEn(await getPool(), opts)
}

export async function obtenerKpisEn(e: Ejecutor): Promise<Kpis> {
  const r = await e.request().query(`
    SELECT
      SUM(CASE WHEN ESTADO = 'leido' THEN 1 ELSE 0 END)       AS pendientes,
      SUM(CASE WHEN ESTADO = 'observacion' THEN 1 ELSE 0 END) AS enObservacion,
      SUM(CASE WHEN ESTADO = 'registrado'
                AND CAST(FECHA_REGISTRO AS DATE) = CAST(SYSDATETIME() AS DATE)
               THEN 1 ELSE 0 END)                             AS registradosHoy,
      ISNULL(SUM(CASE WHEN ESTADO IN ('leido','observacion')
                      THEN ISNULL(TOTAL, 0) ELSE 0 END), 0)   AS importePendiente
    FROM PHF_COMPROBANTE
  `)
  const k = r.recordset[0]
  return {
    pendientes: Number(k.pendientes ?? 0),
    enObservacion: Number(k.enObservacion ?? 0),
    registradosHoy: Number(k.registradosHoy ?? 0),
    importePendiente: Number(k.importePendiente ?? 0),
  }
}

export async function obtenerKpis(): Promise<Kpis> {
  return obtenerKpisEn(await getPool())
}

export async function contarPorEstadoEn(e: Ejecutor, query: string): Promise<Conteos> {
  const r = await pedido(e, 'todos', query).query(`
    SELECT ESTADO, COUNT(*) AS n,
           SUM(CASE WHEN ${WHERE_A_VINCULAR} THEN 1 ELSE 0 END) AS aVincular
    FROM PHF_COMPROBANTE
    WHERE ${WHERE_BUSQUEDA}
    GROUP BY ESTADO
  `)

  const c: Conteos = {
    todos: 0,
    procesando: 0,
    leido: 0,
    observacion: 0,
    confirmado: 0,
    registrado: 0,
    existente: 0,
    error: 0,
    vincular: 0,
  }
  for (const row of r.recordset) {
    c[String(row.ESTADO) as Estado] = Number(row.n)
    c.todos += Number(row.n)
    c.vincular += Number(row.aVincular ?? 0)
  }
  return c
}

export async function contarPorEstado(query: string): Promise<Conteos> {
  return contarPorEstadoEn(await getPool(), query)
}

export type Encabezado = {
  id: number
  archivoNombre: string
  /**
   * Si el archivo guardado es una imagen (JPG/PNG) y no un PDF. Sale de la
   * extension de ARCHIVO_RUTA, que `nombreSeguro` garantiza admitida -- el
   * nombre original puede no tener extension. Decide que visor se abre.
   */
  esImagen: boolean
  estado: Estado
  tipo: string | null
  puntoVenta: string | null
  numero: string | null
  razonSocial: string | null
  cuit: string | null
  confianzaPromedio: number | null
  extraccionMs: number | null
  extraccionModelo: string | null
  errorMensaje: string | null
  /** El asiento que dejo en Tango, si llego a registrarse. */
  tangoNComp: string | null
  /** Por que esta en observacion. Solo tiene valor en ese estado. */
  motivoObservacion: string | null
  notaObservacion: string | null
}

/**
 * Lo que hace falta para montar la pantalla de revisión: el nombre de
 * archivo para la barra del visor, los datos de cabecera para la barra de
 * acciones (proveedor, comprobante, estado) y lo que dejó la extracción
 * (para el aviso de lectura IA y el mensaje de error). Confirma también que
 * el comprobante existe (si no, la página muestra 404 en vez de una
 * pantalla vacía).
 */
export async function obtenerEncabezadoEn(e: Ejecutor, id: number): Promise<Encabezado | null> {
  const r = await e
    .request()
    .input('id', sql.Int, id)
    .query<Record<string, unknown>>(`
      SELECT ID, ARCHIVO_NOMBRE, ARCHIVO_RUTA, ESTADO, TIPO, PUNTO_VENTA, NUMERO,
             RAZON_SOCIAL, CUIT, CONFIANZA_PROMEDIO, EXTRACCION_MS,
             EXTRACCION_MODELO, ERROR_MENSAJE, TANGO_N_COMP,
             MOTIVO_OBSERVACION, NOTA_OBSERVACION
      FROM PHF_COMPROBANTE WHERE ID = @id
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return {
    id: Number(row.ID),
    archivoNombre: String(row.ARCHIVO_NOMBRE),
    esImagen: (() => {
      const t = tipoPorNombre(String(row.ARCHIVO_RUTA ?? ''))
      return t !== null && esImagen(t)
    })(),
    estado: String(row.ESTADO) as Estado,
    tipo: row.TIPO ? String(row.TIPO) : null,
    puntoVenta: row.PUNTO_VENTA ? String(row.PUNTO_VENTA) : null,
    numero: row.NUMERO ? String(row.NUMERO) : null,
    razonSocial: row.RAZON_SOCIAL ? String(row.RAZON_SOCIAL) : null,
    cuit: row.CUIT ? String(row.CUIT) : null,
    confianzaPromedio:
      row.CONFIANZA_PROMEDIO === null || row.CONFIANZA_PROMEDIO === undefined
        ? null
        : Number(row.CONFIANZA_PROMEDIO),
    extraccionMs: row.EXTRACCION_MS === null || row.EXTRACCION_MS === undefined ? null : Number(row.EXTRACCION_MS),
    extraccionModelo: row.EXTRACCION_MODELO ? String(row.EXTRACCION_MODELO) : null,
    errorMensaje: row.ERROR_MENSAJE ? String(row.ERROR_MENSAJE) : null,
    tangoNComp: row.TANGO_N_COMP ? String(row.TANGO_N_COMP) : null,
    motivoObservacion: row.MOTIVO_OBSERVACION ? String(row.MOTIVO_OBSERVACION) : null,
    notaObservacion: row.NOTA_OBSERVACION ? String(row.NOTA_OBSERVACION) : null,
  }
}

export async function obtenerEncabezado(id: number): Promise<Encabezado | null> {
  return obtenerEncabezadoEn(await getPool(), id)
}

export type Vecinos = { anteriorId: number | null; siguienteId: number | null }

/**
 * Anterior/siguiente dentro del mismo filtro y busqueda de la bandeja (para
 * la navegacion J/K de la pantalla de revision), respetando el mismo orden
 * que `listarComprobantesEn`: FECHA_ALTA DESC, ID DESC. "Anterior" es mas
 * nuevo (arriba en la bandeja); "siguiente" es mas viejo (abajo).
 *
 * Todo en una sola consulta con LAG/LEAD sobre el conjunto ya filtrado, en
 * vez de leer el FECHA_ALTA de la fila y volver a mandarlo como parametro
 * para comparar contra las demas filas. Se probaron las dos alternativas
 * de ida y vuelta (comparar @fecha con y sin excluir el propio ID) y las
 * dos fallan bajo carga: FECHA_ALTA es DATETIME2 (100ns) pero el Date de
 * JS solo llega a milisegundos, asi que @fecha viaja truncado hacia abajo.
 * Con insercion rapida (como en los tests, o varias filas dadas de alta
 * casi al mismo tiempo) el FECHA_ALTA real de una fila mas vieja puede
 * seguir siendo mayor que la version truncada de una fila mas nueva, y se
 * cuela como vecino aunque el ID la delate. LAG/LEAD comparan siempre
 * contra el valor completo tal cual esta en la fila, sin ese round-trip,
 * asi que no tienen ese problema.
 */
export async function obtenerVecinosEn(
  e: Ejecutor,
  { filtro, query }: { filtro: ClaveTab; query: string },
  id: number,
): Promise<Vecinos> {
  const r = await pedido(e, filtro, query)
    .input('id', sql.Int, id)
    .query<Record<string, unknown>>(`
      WITH ordenado AS (
        SELECT
          ID,
          LAG(ID) OVER (ORDER BY FECHA_ALTA DESC, ID DESC)  AS ANTERIOR_ID,
          LEAD(ID) OVER (ORDER BY FECHA_ALTA DESC, ID DESC) AS SIGUIENTE_ID
        FROM PHF_COMPROBANTE
        WHERE ${WHERE_ESTADO} AND ${WHERE_BUSQUEDA}
      )
      SELECT ANTERIOR_ID, SIGUIENTE_ID FROM ordenado WHERE ID = @id
    `)

  if (r.recordset.length === 0) return { anteriorId: null, siguienteId: null }
  const row = r.recordset[0]
  return {
    anteriorId: row.ANTERIOR_ID === null || row.ANTERIOR_ID === undefined ? null : Number(row.ANTERIOR_ID),
    siguienteId: row.SIGUIENTE_ID === null || row.SIGUIENTE_ID === undefined ? null : Number(row.SIGUIENTE_ID),
  }
}

export async function obtenerVecinos(opts: { filtro: ClaveTab; query: string }, id: number): Promise<Vecinos> {
  return obtenerVecinosEn(await getPool(), opts, id)
}

/** Inserta un comprobante minimo. Es para los tests, no para la app. */
export async function insertarComprobantePrueba(
  tx: sql.Transaction,
  datos: Partial<FilaBandeja> & { estado: Estado; fechaRegistro?: Date },
): Promise<number> {
  const r = await tx
    .request()
    .input('nombre', sql.NVarChar(260), `prueba-${Date.now()}-${Math.random()}.pdf`)
    .input('ruta', sql.NVarChar(500), 'prueba')
    .input('hash', sql.Char(64), '0'.repeat(64))
    .input('estado', sql.VarChar(20), datos.estado)
    .input('tipo', sql.VarChar(10), datos.tipo ?? null)
    .input('pv', sql.VarChar(10), datos.puntoVenta ?? null)
    .input('numero', sql.VarChar(20), datos.numero ?? null)
    .input('razon', sql.NVarChar(200), datos.razonSocial ?? null)
    .input('cuit', sql.VarChar(15), datos.cuit ?? null)
    .input('total', sql.Decimal(19, 4), datos.total ?? null)
    .input('fechaEmision', sql.Date, datos.fechaEmision ?? null)
    .input('fechaRegistro', sql.DateTime2, datos.fechaRegistro ?? null)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO, PUNTO_VENTA,
         NUMERO, RAZON_SOCIAL, CUIT, TOTAL, FECHA_EMISION, FECHA_REGISTRO, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, @estado, @tipo, @pv,
              @numero, @razon, @cuit, @total, @fechaEmision, @fechaRegistro, @usuario)
    `)
  return Number(r.recordset[0].ID)
}

/** Inserta un renglon minimo para un comprobante de prueba. Es para los tests. */
export async function insertarRenglonPrueba(
  e: Ejecutor,
  comprobanteId: number,
  datos: { codigo: string; descripcion: string; cantidad: string; precioUnitario: string; importe: string },
): Promise<number> {
  const r = await e.request()
    .input('cid', sql.Int, comprobanteId)
    .input('cod', sql.VarChar(60), datos.codigo).input('desc', sql.NVarChar(300), datos.descripcion)
    .input('cant', sql.VarChar(30), datos.cantidad).input('precio', sql.VarChar(30), datos.precioUnitario)
    .input('imp', sql.VarChar(30), datos.importe)
    .query(`
      INSERT INTO PHF_RENGLON (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
      OUTPUT INSERTED.ID
      SELECT @cid, ISNULL(MAX(ORDEN), 0) + 1, @cod, @desc, @cant, @precio, @imp
      FROM PHF_RENGLON WHERE COMPROBANTE_ID = @cid`)
  return Number(r.recordset[0].ID)
}

/**
 * Un renglón del PDF (PHF_RENGLON_PDF) para los tests de registro contra
 * una orden de compra: desde el 2026-09-15 el precio que se graba en CPA46
 * sale del subtotal impreso, así que sin esta fila el registro corta.
 */
export async function insertarRenglonPdfPrueba(
  e: Ejecutor,
  comprobanteId: number,
  orden: number,
  codigo: string,
  cantidad: string,
  precioImpreso: string,
  subtotalImpreso: string,
): Promise<void> {
  await e.request()
    .input('cid', sql.Int, comprobanteId).input('orden', sql.Int, orden)
    .input('cod', sql.NVarChar(60), codigo).input('cant', sql.Decimal(19, 4), Number(cantidad))
    .input('precio', sql.Decimal(19, 4), Number(precioImpreso))
    .input('sub', sql.Decimal(19, 4), Number(subtotalImpreso))
    .query(`
      INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, CANTIDAD, PRECIO_IMPRESO, SUBTOTAL_IMPRESO)
      VALUES (@cid, @orden, @cod, @cant, @precio, @sub)`)
}
