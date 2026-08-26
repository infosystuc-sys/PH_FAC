import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { conRollback } from '@/server/db/tx'
import { cerrarPool, getPool } from '@/server/db/pool'
import {
  leerConfiguracionCarpetasEn,
  guardarConfiguracionCarpetasEn,
  escanearCarpetasEn,
  escanearRaizEn,
} from '@/server/app/carpetas'

const tmpDirs: string[] = []
const idsCreados: number[] = []

afterAll(async () => {
  const pool = await getPool()
  for (const id of idsCreados) {
    const r = await pool
      .request()
      .input('id', sql.Int, id)
      .query('SELECT ARCHIVO_RUTA FROM PHF_COMPROBANTE WHERE ID = @id')
    if (r.recordset[0]) await rm(String(r.recordset[0].ARCHIVO_RUTA), { force: true })
    // PHF_AUDITORIA tiene ON DELETE CASCADE sobre COMPROBANTE_ID: este DELETE
    // se lleva puesta tambien la entrada de auditoria que dejo el import.
    await pool.request().input('id', sql.Int, id).query('DELETE FROM PHF_COMPROBANTE WHERE ID = @id')
  }
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
  await cerrarPool()
})

async function carpetaTemporal(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'phf-carpetas-'))
  tmpDirs.push(dir)
  return dir
}

/** Deja el PDF con un mtime viejo para que el filtro de estabilidad no lo descarte. */
async function dejarPdfEstable(ruta: string, datos: Buffer): Promise<void> {
  await writeFile(ruta, datos)
  const haceUnMinuto = new Date(Date.now() - 60_000)
  await utimes(ruta, haceUnMinuto, haceUnMinuto)
}

describe('guardarConfiguracionCarpetasEn / leerConfiguracionCarpetasEn', () => {
  it('guarda y relee la carpeta raiz y el intervalo', async () => {
    await conRollback(async (tx) => {
      await guardarConfiguracionCarpetasEn(tx, '  D:\\Comprobantes  ', 30)
      const config = await leerConfiguracionCarpetasEn(tx)
      expect(config.carpetaRaiz).toBe('D:\\Comprobantes')
      expect(config.intervaloMinutos).toBe(30)
    })
  })

  it('normaliza una carpeta vacia (o solo espacios) a null', async () => {
    await conRollback(async (tx) => {
      await guardarConfiguracionCarpetasEn(tx, '   ', 15)
      const config = await leerConfiguracionCarpetasEn(tx)
      expect(config.carpetaRaiz).toBeNull()
    })
  })

  it('rechaza un intervalo menor a 1 minuto', async () => {
    await conRollback(async (tx) => {
      await expect(guardarConfiguracionCarpetasEn(tx, 'D:\\x', 0)).rejects.toThrow(/al menos 1 minuto/)
    })
  })
})

describe('escanearCarpetasEn', () => {
  it('no hace nada si no hay carpeta raiz configurada', async () => {
    await conRollback(async (tx) => {
      await guardarConfiguracionCarpetasEn(tx, null, 15)
      const resultado = await escanearCarpetasEn(tx)
      expect(resultado).toEqual({ importados: 0, duplicados: 0, errores: 0 })
    })
  })
})

describe('escanearRaizEn', () => {
  it('crea la estructura de subcarpetas para los tres tipos', async () => {
    const raiz = await carpetaTemporal()
    await escanearRaizEn(raiz)
    for (const tipo of ['conceptos', 'articulos', 'tarjeta']) {
      const entradas = await readdir(path.join(raiz, tipo))
      expect(entradas.sort()).toEqual(['error', 'procesados'])
    }
  })

  it('un archivo modificado hace menos de 10 segundos no se toca en este ciclo', async () => {
    const raiz = await carpetaTemporal()
    const carpetaArticulos = path.join(raiz, 'articulos')
    await mkdir(carpetaArticulos, { recursive: true })
    const nombre = `reciente-${Date.now()}.pdf`
    await writeFile(path.join(carpetaArticulos, nombre), Buffer.from('%PDF-1.4 recien copiado'))

    const resultado = await escanearRaizEn(raiz)
    expect(resultado).toEqual({ importados: 0, duplicados: 0, errores: 0 })

    // Sigue ahi, sin tocar.
    const entradas = await readdir(carpetaArticulos)
    expect(entradas).toContain(nombre)
  })

  it('importa un PDF estable y lo mueve a procesados/', async () => {
    const raiz = await carpetaTemporal()
    const carpetaArticulos = path.join(raiz, 'articulos')
    await mkdir(carpetaArticulos, { recursive: true })
    const nombre = `factura-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`
    const rutaOriginal = path.join(carpetaArticulos, nombre)
    await dejarPdfEstable(rutaOriginal, Buffer.from(`%PDF-1.4 articulos ${nombre}`))

    const resultado = await escanearRaizEn(raiz)
    expect(resultado).toEqual({ importados: 1, duplicados: 0, errores: 0 })

    const pool = await getPool()
    const r = await pool
      .request()
      .input('nombre', sql.NVarChar(260), nombre)
      .query('SELECT ID, TIPO_FACTURA, ESTADO FROM PHF_COMPROBANTE WHERE ARCHIVO_NOMBRE = @nombre')
    expect(r.recordset).toHaveLength(1)
    idsCreados.push(Number(r.recordset[0].ID))
    expect(r.recordset[0].TIPO_FACTURA).toBe('articulos')
    expect(r.recordset[0].ESTADO).toBe('procesando')

    // Se movio: ya no esta directo en articulos/, esta en procesados/.
    const directo = (await readdir(carpetaArticulos)).filter((f) => f.endsWith('.pdf'))
    expect(directo).toEqual([])
    const procesados = await readdir(path.join(carpetaArticulos, 'procesados'))
    expect(procesados.some((f) => f.endsWith(nombre))).toBe(true)
  })

  it('un archivo ya en procesados/ nunca se vuelve a levantar en un escaneo posterior', async () => {
    const raiz = await carpetaTemporal()
    const carpetaConceptos = path.join(raiz, 'conceptos')
    await mkdir(carpetaConceptos, { recursive: true })
    const nombre = `unavez-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`
    await dejarPdfEstable(path.join(carpetaConceptos, nombre), Buffer.from(`%PDF-1.4 conceptos ${nombre}`))

    const primera = await escanearRaizEn(raiz)
    expect(primera.importados).toBe(1)
    const pool = await getPool()
    const r = await pool
      .request()
      .input('nombre', sql.NVarChar(260), nombre)
      .query('SELECT ID FROM PHF_COMPROBANTE WHERE ARCHIVO_NOMBRE = @nombre')
    idsCreados.push(Number(r.recordset[0].ID))

    const segunda = await escanearRaizEn(raiz)
    expect(segunda).toEqual({ importados: 0, duplicados: 0, errores: 0 })
  })

  it('un PDF con el mismo hash que uno ya importado va a error/ con el motivo, sin crear una fila nueva', async () => {
    const raiz = await carpetaTemporal()
    const carpetaTarjeta = path.join(raiz, 'tarjeta')
    await mkdir(carpetaTarjeta, { recursive: true })
    const contenido = Buffer.from(`%PDF-1.4 tarjeta duplicado ${Date.now()}`)

    const primerNombre = `original-${Date.now()}.pdf`
    await dejarPdfEstable(path.join(carpetaTarjeta, primerNombre), contenido)
    const primera = await escanearRaizEn(raiz)
    expect(primera.importados).toBe(1)

    const pool = await getPool()
    const r = await pool
      .request()
      .input('nombre', sql.NVarChar(260), primerNombre)
      .query('SELECT ID FROM PHF_COMPROBANTE WHERE ARCHIVO_NOMBRE = @nombre')
    const idOriginal = Number(r.recordset[0].ID)
    idsCreados.push(idOriginal)

    // Mismo contenido, nombre de archivo distinto -- el hash es lo que importa.
    const segundoNombre = `copia-${Date.now()}.pdf`
    await dejarPdfEstable(path.join(carpetaTarjeta, segundoNombre), contenido)
    const segunda = await escanearRaizEn(raiz)
    expect(segunda).toEqual({ importados: 0, duplicados: 1, errores: 0 })

    // No se creo una segunda fila para el duplicado.
    const total = await pool
      .request()
      .input('nombre', sql.NVarChar(260), segundoNombre)
      .query('SELECT COUNT(*) AS n FROM PHF_COMPROBANTE WHERE ARCHIVO_NOMBRE = @nombre')
    expect(total.recordset[0].n).toBe(0)

    // El PDF quedo en error/ con un .txt explicando el motivo, referenciando
    // el comprobante original.
    const errores = await readdir(path.join(carpetaTarjeta, 'error'))
    const pdfEnError = errores.find((f) => f.endsWith(segundoNombre))
    const txtEnError = errores.find((f) => f.endsWith(`${segundoNombre}.txt`))
    expect(pdfEnError).toBeDefined()
    expect(txtEnError).toBeDefined()
    const motivo = await readFile(path.join(carpetaTarjeta, 'error', txtEnError!), 'utf-8')
    expect(motivo).toContain(`#${idOriginal}`)
  })
})
