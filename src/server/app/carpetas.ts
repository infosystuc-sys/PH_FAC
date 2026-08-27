import sql from 'mssql'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { TIPOS_FACTURA, type TipoFactura } from '@/lib/tipoFactura'
import { importarComprobanteEn, despertarWorker } from './cola'
import { buscarComprobantePorHashEn } from './detalle'

type Ejecutor = { request(): sql.Request }

export type ConfiguracionCarpetas = {
  carpetaRaiz: string | null
  intervaloMinutos: number
  ultimoEscaneo: Date | null
  ultimoResultado: string | null
}

export type ResultadoEscaneo = {
  importados: number
  duplicados: number
  errores: number
}

const RESULTADO_VACIO: ResultadoEscaneo = { importados: 0, duplicados: 0, errores: 0 }

/** Un PDF con menos de esto de antiguedad se deja para el proximo ciclo: puede seguir copiandose. */
const ESPERA_ESTABILIDAD_MS = 10_000

export async function leerConfiguracionCarpetasEn(e: Ejecutor): Promise<ConfiguracionCarpetas> {
  const r = await e.request().query(`
    SELECT CARPETA_RAIZ, INTERVALO_MINUTOS, ULTIMO_ESCANEO, ULTIMO_RESULTADO
    FROM PHF_CONFIGURACION WHERE ID = 1
  `)
  const row = r.recordset[0]
  return {
    carpetaRaiz: row.CARPETA_RAIZ ?? null,
    intervaloMinutos: Number(row.INTERVALO_MINUTOS),
    ultimoEscaneo: row.ULTIMO_ESCANEO ?? null,
    ultimoResultado: row.ULTIMO_RESULTADO ?? null,
  }
}

export async function guardarConfiguracionCarpetasEn(
  e: Ejecutor,
  carpetaRaiz: string | null,
  intervaloMinutos: number,
): Promise<void> {
  if (!Number.isFinite(intervaloMinutos) || intervaloMinutos < 1) {
    throw new Error('El intervalo tiene que ser de al menos 1 minuto.')
  }
  const raiz = carpetaRaiz?.trim() || null
  await e
    .request()
    .input('raiz', sql.NVarChar(500), raiz)
    .input('min', sql.Int, Math.trunc(intervaloMinutos))
    .query('UPDATE PHF_CONFIGURACION SET CARPETA_RAIZ = @raiz, INTERVALO_MINUTOS = @min WHERE ID = 1')
}

async function actualizarUltimoEscaneoEn(e: Ejecutor, resultado: ResultadoEscaneo): Promise<void> {
  const texto = `${resultado.importados} importado(s), ${resultado.duplicados} duplicado(s), ${resultado.errores} error(es)`
  await e
    .request()
    .input('texto', sql.NVarChar(500), texto)
    .query('UPDATE PHF_CONFIGURACION SET ULTIMO_ESCANEO = SYSDATETIME(), ULTIMO_RESULTADO = @texto WHERE ID = 1')
}

function marcaTiempo(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function carpetaDeTipo(raiz: string, tipo: TipoFactura): string {
  return path.join(raiz, tipo)
}

async function asegurarSubcarpetas(carpetaTipo: string): Promise<void> {
  await mkdir(path.join(carpetaTipo, 'procesados'), { recursive: true })
  await mkdir(path.join(carpetaTipo, 'error'), { recursive: true })
}

/**
 * Los `*.pdf` directamente adentro de `dir` (nunca recursivo: no vuelve a
 * entrar a `procesados/`/`error/`), descartando los que se modificaron hace
 * menos de `ESPERA_ESTABILIDAD_MS` -- para no agarrar un archivo que un
 * proceso externo todavia esta terminando de copiar a la carpeta.
 */
async function listarPdfsEstables(dir: string): Promise<string[]> {
  const entradas = await readdir(dir, { withFileTypes: true })
  const ahora = Date.now()
  const candidatos: string[] = []
  for (const entrada of entradas) {
    if (!entrada.isFile() || !entrada.name.toLowerCase().endsWith('.pdf')) continue
    const ruta = path.join(dir, entrada.name)
    const info = await stat(ruta)
    if (ahora - info.mtimeMs < ESPERA_ESTABILIDAD_MS) continue
    candidatos.push(ruta)
  }
  return candidatos
}

async function moverAProcesados(ruta: string, carpetaTipo: string): Promise<void> {
  const destino = path.join(carpetaTipo, 'procesados', `${marcaTiempo()}-${path.basename(ruta)}`)
  await rename(ruta, destino)
}

async function moverAError(ruta: string, carpetaTipo: string, motivo: string): Promise<void> {
  const destino = path.join(carpetaTipo, 'error', `${marcaTiempo()}-${path.basename(ruta)}`)
  await rename(ruta, destino)
  await writeFile(`${destino}.txt`, motivo, 'utf-8')
}

/**
 * El trabajo de verdad: escanea las tres subcarpetas de tipo dentro de
 * `carpetaRaiz` e importa lo que encuentre. Separado de `escanearCarpetasEn`
 * (que lee `carpetaRaiz` de `PHF_CONFIGURACION`) para poder probarlo contra
 * una carpeta temporal sin tocar la configuracion real de producción.
 *
 * Cada archivo se importa en su propia transaccion (`conTransaccion`,
 * mismo criterio que ya usa `importarComprobantes` para la carga manual en
 * lote): que un archivo falle no debe dejar sin commitear los que ya se
 * importaron antes en este mismo ciclo.
 */
export async function escanearRaizEn(carpetaRaiz: string): Promise<ResultadoEscaneo> {
  const resultado: ResultadoEscaneo = { importados: 0, duplicados: 0, errores: 0 }
  const pool = await getPool()

  for (const { clave: tipo } of TIPOS_FACTURA) {
    const carpetaTipo = carpetaDeTipo(carpetaRaiz, tipo)

    try {
      await asegurarSubcarpetas(carpetaTipo)
    } catch {
      // Raiz configurada inaccesible (ruta de red caida, por ejemplo): se
      // sigue con el proximo tipo en vez de abortar todo el ciclo.
      resultado.errores += 1
      continue
    }

    let archivos: string[]
    try {
      archivos = await listarPdfsEstables(carpetaTipo)
    } catch {
      continue
    }

    for (const ruta of archivos) {
      try {
        const datos = await readFile(ruta)
        const hash = createHash('sha256').update(datos).digest('hex')
        const existenteId = await buscarComprobantePorHashEn(pool, hash)

        if (existenteId !== null) {
          await moverAError(ruta, carpetaTipo, `Ya se había importado antes: comprobante #${existenteId}.`)
          resultado.duplicados += 1
          continue
        }

        await conTransaccion((tx) =>
          importarComprobanteEn(tx, path.basename(ruta), datos, tipo, 'escaneo automático de carpeta'),
        )
        await moverAProcesados(ruta, carpetaTipo)
        resultado.importados += 1
      } catch (err) {
        const mensaje = err instanceof Error ? err.message : String(err)
        await moverAError(ruta, carpetaTipo, mensaje).catch(() => {})
        resultado.errores += 1
      }
    }
  }

  if (resultado.importados > 0) despertarWorker()
  return resultado
}

/** Punto de entrada real: lee la carpeta configurada y anota el resultado. Es lo que llama el ciclo periodico. */
export async function escanearCarpetasEn(e: Ejecutor): Promise<ResultadoEscaneo> {
  const config = await leerConfiguracionCarpetasEn(e)
  if (!config.carpetaRaiz) return RESULTADO_VACIO

  const resultado = await escanearRaizEn(config.carpetaRaiz)
  await actualizarUltimoEscaneoEn(e, resultado)
  return resultado
}

let escaneando = false
let temporizadorCarpetas: ReturnType<typeof setTimeout> | null = null

async function cicloCarpetas(): Promise<void> {
  let minutos = 1
  try {
    const pool = await getPool()
    const config = await leerConfiguracionCarpetasEn(pool)
    minutos = config.intervaloMinutos > 0 ? config.intervaloMinutos : 1
    if (config.carpetaRaiz) await escanearCarpetasEn(pool)
  } catch (err) {
    // No se deja escapar -- el ciclo tiene que seguir reprogramandose pase
    // lo que pase -- pero silenciarlo del todo hizo dificil de diagnosticar
    // un fallo real (ver RETOMAR.md, "instrumentation.ts en el lugar
    // equivocado"): al menos queda en el log del servidor.
    console.error('[carpetas] fallo el ciclo de escaneo, reintenta en la proxima vuelta:', err)
  } finally {
    temporizadorCarpetas = setTimeout(() => void cicloCarpetas(), minutos * 60 * 1000)
  }
}

/** Arranca el ciclo periodico en proceso. Se llama una vez desde instrumentation.ts. */
export function arrancarEscaneoCarpetas(): void {
  if (temporizadorCarpetas) return
  void cicloCarpetas()
}

/** Dispara un escaneo ya, sin esperar al ciclo. Botón "Escanear ahora". */
export function escanearCarpetasAhora(): void {
  if (escaneando) return
  escaneando = true
  getPool()
    .then((pool) => escanearCarpetasEn(pool))
    .catch((err) => console.error('[carpetas] fallo el escaneo manual:', err))
    .finally(() => {
      escaneando = false
    })
}
