import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const RAIZ = path.resolve(__dirname, '..')

/**
 * La app no lee ni escribe ninguna tabla `CTA*` (el espejo de Tango Central:
 * `CTA05`, `CTA06`, `CTA07`, `CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA`,
 * …) -- decisión del usuario, 2026-11-03. Si Tango las llena con un trigger,
 * que lo haga él; esta app no guarda datos ahí.
 *
 * Hasta esa fecha `registrarComprobanteEn` insertaba en cuatro de ellas.
 * Este test barre el código y falla si una sentencia SQL vuelve a nombrar
 * una `CTA*` después de INTO, UPDATE, FROM, JOIN o MERGE.
 */
const SQL_CONTRA_CTA = /\b(INTO|UPDATE|FROM|JOIN|MERGE)\s+(\[?dbo\]?\.)?\[?CTA[0-9_A-Z]*\b/i

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = path.join(dir, nombre)
    if (statSync(ruta).isDirectory()) return archivos(ruta)
    return /\.(ts|tsx|sql)$/.test(nombre) ? [ruta] : []
  })
}

describe('frontera con las tablas CTA*', () => {
  it('ningún archivo de src/ ni de scripts/ emite SQL contra una tabla CTA*', () => {
    const encontrados: string[] = []
    for (const archivo of [...archivos(path.join(RAIZ, 'src')), ...archivos(path.join(RAIZ, 'scripts'))]) {
      readFileSync(archivo, 'utf-8')
        .split('\n')
        .forEach((linea, i) => {
          if (SQL_CONTRA_CTA.test(linea)) {
            encontrados.push(`${path.relative(RAIZ, archivo)}:${i + 1}: ${linea.trim()}`)
          }
        })
    }
    expect(encontrados).toEqual([])
  })

  it('el patrón detecta las formas en que se escribía', () => {
    expect(SQL_CONTRA_CTA.test('INSERT INTO CTA05 (')).toBe(true)
    expect(SQL_CONTRA_CTA.test('INSERT INTO CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA (ID')).toBe(true)
    expect(SQL_CONTRA_CTA.test('SELECT * FROM dbo.CTA07 WHERE')).toBe(true)
    expect(SQL_CONTRA_CTA.test('LEFT JOIN [CTA06] t ON')).toBe(true)
    // Texto que no es una tabla: una condición de compra "CTA CTE".
    expect(SQL_CONTRA_CTA.test("'CTA CTE 30-60-90 DIAS'")).toBe(false)
    expect(SQL_CONTRA_CTA.test('INSERT INTO CPA04 (')).toBe(false)
  })
})
