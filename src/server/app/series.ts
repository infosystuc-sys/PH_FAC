import sql from 'mssql'
import { normalizarSerie, problemaSeries, type Serie } from '@/lib/series'
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

/** Un renglón del remito cuyo artículo usa número de serie, con lo cargado. */
export type RenglonConSerie = {
  renglonId: number
  codArticu: string
  descripcion: string | null
  cantidad: number
  series: Serie[]
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
  renglones: { id: number; codigo: string | null; codigoFinal: string | null; descripcion: string | null; cantidad: string | null }[],
): Promise<RenglonConSerie[]> {
  const codigoDe = (r: (typeof renglones)[number]) => (r.codigoFinal ?? r.codigo ?? '').trim()
  // Secuencial: `e` puede ser una transaccion (ver validaciones.ts).
  const conSerie = await articulosConSerie(renglones.map(codigoDe), e)
  if (conSerie.size === 0) return []
  const guardadas = await seriesDelComprobanteEn(e, comprobanteId)

  const resultado: RenglonConSerie[] = []
  const vistas = new Map<string, number>()
  for (const r of renglones) {
    const codArticu = codigoDe(r)
    if (!conSerie.has(codArticu)) continue
    const cantidad = parsearImporte(r.cantidad)
    const series = guardadas.get(r.id) ?? []
    let problema = problemaSeries(codArticu, cantidad, series)
    if (!problema) {
      for (const s of series.filter((x) => x.nSerie !== '')) {
        const clave = `${codArticu}\u0000${s.nSerie}`
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
    resultado.push({ renglonId: r.id, codArticu, descripcion: r.descripcion, cantidad, series, problema })
  }
  return resultado
}
