import sql from 'mssql'
import { normalizarSerie, problemaSeries, LARGO_SERIE, type Serie } from '@/lib/series'
import type { ReglaSeries } from '@/lib/seriesProveedor'
import { parsearImporte } from '@/lib/formato'
import { articulosConSerie, seriesYaEnStock } from '@/server/tango/series'

/**
 * Las series que carga el operador para los renglones de un remito cuyo
 * artículo usa número de serie (2026-11-04). Viven en PHF_SERIE hasta que
 * el registro las graba en Tango (ver `src/server/tango/series.ts`).
 */

type Ejecutor = { request(): sql.Request }

/** Las series guardadas de cada renglón del comprobante, por ID de renglón. */
export async function seriesDelComprobanteEn(e: Ejecutor, comprobanteId: number): Promise<Map<number, Serie[]>> {
  const r = await e.request().input('id', sql.Int, comprobanteId).query(`
    SELECT s.RENGLON_ID, s.N_SERIE, s.DESC1, s.DESC2, s.COMENTARIO
    FROM PHF_SERIE s JOIN PHF_RENGLON r ON r.ID = s.RENGLON_ID
    WHERE r.COMPROBANTE_ID = @id
    ORDER BY s.RENGLON_ID, s.ORDEN`)
  const porRenglon = new Map<number, Serie[]>()
  for (const x of r.recordset) {
    const id = Number(x.RENGLON_ID)
    const lista = porRenglon.get(id) ?? []
    lista.push(normalizarSerie({
      nSerie: x.N_SERIE ?? '',
      desc1: x.DESC1 ?? '',
      desc2: x.DESC2 ?? '',
      comentario: x.COMENTARIO ?? '',
    }))
    porRenglon.set(id, lista)
  }
  return porRenglon
}

/**
 * Reemplaza las series de un renglón. Se guardan también las filas a medio
 * cargar (con descripción pero sin serie todavía), para que el operador no
 * pierda lo tipeado; las vacías del todo no se guardan.
 *
 * No escribe si el comprobante ya está registrado o es `existente`: mismo
 * freno que `guardarCampoEn`.
 */
export async function guardarSeriesEn(
  e: Ejecutor,
  comprobanteId: number,
  renglonId: number,
  series: Partial<Serie>[],
): Promise<void> {
  const ok = await e.request().input('id', sql.Int, comprobanteId).input('r', sql.Int, renglonId).query(`
    SELECT 1 AS x FROM PHF_RENGLON r JOIN PHF_COMPROBANTE c ON c.ID = r.COMPROBANTE_ID
    WHERE r.ID = @r AND c.ID = @id AND c.ESTADO NOT IN ('registrado', 'existente')`)
  if (ok.recordset.length === 0) {
    throw new Error('El renglón ya no existe o el comprobante ya está registrado.')
  }
  await e.request().input('r', sql.Int, renglonId).query('DELETE FROM PHF_SERIE WHERE RENGLON_ID = @r')
  let orden = 0
  for (const crudo of series) {
    const s = normalizarSerie(crudo)
    if (!s.nSerie && !s.desc1 && !s.desc2 && !s.comentario) continue
    orden += 1
    await e.request()
      .input('r', sql.Int, renglonId)
      .input('orden', sql.Int, orden)
      .input('serie', sql.NVarChar(30), s.nSerie.slice(0, 30))
      .input('desc1', sql.NVarChar(25), s.desc1.slice(0, 25))
      .input('desc2', sql.NVarChar(25), s.desc2.slice(0, 25))
      .input('comentario', sql.NVarChar(25), s.comentario.slice(0, 25))
      .query(`
        INSERT INTO PHF_SERIE (RENGLON_ID, ORDEN, N_SERIE, DESC1, DESC2, COMENTARIO)
        VALUES (@r, @orden, @serie, @desc1, @desc2, @comentario)`)
  }
}

/** Un renglón de PHF_RENGLON, con lo justo para resolver sus series. */
export type RenglonParaSeries = {
  id: number
  orden: number
  codigo: string | null
  codigoFinal: string | null
  descripcion: string | null
  cantidad: string | null
  /** El renglón del PDF del que salió: ahí están las series leídas. */
  pdfOrden: number | null
}

/**
 * De dónde salen las series que valen para un renglón:
 * - 'cargadas': las guardó el operador (PHF_SERIE). Ganan siempre.
 * - 'leidas': las leyó la IA del comprobante (PHF_SERIE_PDF) y el operador
 *   todavía no las guardó.
 * - 'ninguna': no hay.
 */
export type OrigenSeries = 'cargadas' | 'leidas' | 'ninguna'

/**
 * Guarda las unidades que leyó la IA del comprobante, ya traducidas a los
 * datos de Tango con la regla del proveedor: N_SERIE y DESC1 de las
 * columnas impresas, DESC2 del código del artículo. Reemplaza lo anterior.
 */
export async function guardarSeriesPdfEn(
  e: Ejecutor,
  comprobanteId: number,
  unidades: { orden: number; serie: string; adicional1: string }[],
  codigoPorOrden: Map<number, string | null>,
  regla: ReglaSeries,
): Promise<number> {
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_SERIE_PDF WHERE COMPROBANTE_ID = @id')
  const contador = new Map<number, number>()
  let total = 0
  for (const u of unidades) {
    if (!codigoPorOrden.has(u.orden)) continue
    const s = normalizarSerie({
      nSerie: u.serie,
      desc1: u.adicional1,
      desc2: regla.adicional2DelCodigo(codigoPorOrden.get(u.orden) ?? ''),
    })
    if (!s.nSerie) continue
    const orden = (contador.get(u.orden) ?? 0) + 1
    contador.set(u.orden, orden)
    await e.request()
      .input('id', sql.Int, comprobanteId)
      .input('pdf', sql.Int, u.orden)
      .input('orden', sql.Int, orden)
      .input('serie', sql.NVarChar(30), s.nSerie.slice(0, LARGO_SERIE.nSerie))
      .input('desc1', sql.NVarChar(25), s.desc1.slice(0, LARGO_SERIE.desc1))
      .input('desc2', sql.NVarChar(25), s.desc2.slice(0, LARGO_SERIE.desc2))
      .query(`
        INSERT INTO PHF_SERIE_PDF (COMPROBANTE_ID, PDF_ORDEN, ORDEN, N_SERIE, DESC1, DESC2)
        VALUES (@id, @pdf, @orden, @serie, @desc1, @desc2)`)
    total += 1
  }
  return total
}

/**
 * Las series que valen para cada renglón. Las leídas del PDF se reparten
 * entre los renglones que salieron de esa línea, en orden y según la
 * cantidad de cada uno: una línea impresa suele ser un solo renglón, pero
 * podría haberse partido entre dos órdenes de compra.
 */
export async function seriesEfectivasEn(
  e: Ejecutor,
  comprobanteId: number,
  renglones: RenglonParaSeries[],
): Promise<Map<number, { series: Serie[]; origen: OrigenSeries }>> {
  const guardadas = await seriesDelComprobanteEn(e, comprobanteId)
  const leidas = await e.request().input('id', sql.Int, comprobanteId).query(`
    SELECT PDF_ORDEN, N_SERIE, DESC1, DESC2 FROM PHF_SERIE_PDF
    WHERE COMPROBANTE_ID = @id ORDER BY PDF_ORDEN, ORDEN`)
  const porPdf = new Map<number, Serie[]>()
  for (const x of leidas.recordset) {
    const lista = porPdf.get(Number(x.PDF_ORDEN)) ?? []
    lista.push(normalizarSerie({ nSerie: x.N_SERIE ?? '', desc1: x.DESC1 ?? '', desc2: x.DESC2 ?? '' }))
    porPdf.set(Number(x.PDF_ORDEN), lista)
  }

  const resultado = new Map<number, { series: Serie[]; origen: OrigenSeries }>()
  const usadas = new Map<number, number>()
  for (const r of [...renglones].sort((a, b) => a.orden - b.orden)) {
    const propias = guardadas.get(r.id)
    const disponibles = r.pdfOrden !== null ? (porPdf.get(r.pdfOrden) ?? []) : []
    const desde = r.pdfOrden !== null ? (usadas.get(r.pdfOrden) ?? 0) : 0
    const cantidad = Math.max(0, Math.round(parsearImporte(r.cantidad)))
    const delPdf = disponibles.slice(desde, desde + cantidad)
    if (r.pdfOrden !== null) usadas.set(r.pdfOrden, desde + delPdf.length)

    if (propias && propias.length > 0) resultado.set(r.id, { series: propias, origen: 'cargadas' })
    else if (delPdf.length > 0) resultado.set(r.id, { series: delPdf, origen: 'leidas' })
    else resultado.set(r.id, { series: [], origen: 'ninguna' })
  }
  return resultado
}

/** Un renglón del remito cuyo artículo usa número de serie, con lo cargado. */
export type RenglonConSerie = {
  renglonId: number
  codArticu: string
  descripcion: string | null
  cantidad: number
  series: Serie[]
  origen: OrigenSeries
  /** Lo que falta o está mal, o `null` si se puede registrar. */
  problema: string | null
}

/**
 * Los renglones del remito que piden número de serie, cada uno con sus
 * series y lo que les falta. Además de `problemaSeries` (una por unidad,
 * sin repetir), mira dos cosas que solo se ven con el remito entero o con
 * Tango: la misma serie del mismo artículo en dos renglones, y una serie
 * que Tango ya tiene en stock (STA06), que el registro rechazaría.
 */
export async function revisarSeriesEn(
  e: Ejecutor,
  comprobanteId: number,
  renglones: RenglonParaSeries[],
): Promise<RenglonConSerie[]> {
  const codigoDe = (r: RenglonParaSeries) => (r.codigoFinal ?? r.codigo ?? '').trim()
  // Secuencial: `e` puede ser una transaccion (ver validaciones.ts).
  const conSerie = await articulosConSerie(renglones.map(codigoDe), e)
  if (conSerie.size === 0) return []
  const efectivas = await seriesEfectivasEn(e, comprobanteId, renglones)

  const resultado: RenglonConSerie[] = []
  const vistas = new Map<string, number>()
  for (const r of renglones) {
    const codArticu = codigoDe(r)
    if (!conSerie.has(codArticu)) continue
    const cantidad = parsearImporte(r.cantidad)
    const { series, origen } = efectivas.get(r.id) ?? { series: [], origen: 'ninguna' as const }
    let problema = problemaSeries(codArticu, cantidad, series)
    if (!problema) {
      for (const s of series.filter((x) => x.nSerie !== '')) {
        const clave = `${codArticu}|${s.nSerie}`
        if (vistas.has(clave) && vistas.get(clave) !== r.id) {
          problema = `La serie ${s.nSerie} del artículo ${codArticu} está en dos renglones.`
          break
        }
        vistas.set(clave, r.id)
      }
    }
    if (!problema) {
      const enStock = await seriesYaEnStock(codArticu, series.filter((x) => x.nSerie !== '').map((x) => x.nSerie), e)
      if (enStock.length > 0) {
        problema =
          `El artículo ${codArticu} ya tiene en stock la serie ${enStock[0].nSerie} ` +
          `(depósito ${enStock[0].deposito}).`
      }
    }
    resultado.push({ renglonId: r.id, codArticu, descripcion: r.descripcion, cantidad, series, origen, problema })
  }
  return resultado
}
