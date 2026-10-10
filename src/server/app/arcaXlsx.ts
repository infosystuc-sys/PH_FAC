import ExcelJS from 'exceljs'

/**
 * Convierte una hoja de Excel en filas de celdas de texto, para que el
 * lector de ARCA la trate igual que un CSV (2026-10-10, pedido del
 * usuario: la exportación de "Mis Comprobantes" viene en XLSX).
 *
 * Vive del lado del servidor y no en `lib/`: `exceljs` es una dependencia
 * pesada que no tiene por qué viajar al navegador. El archivo se sube, se
 * convierte acá y de ahí en más sigue el mismo camino que el CSV.
 */

/**
 * Cómo se lleva una celda a texto. Importa más de lo que parece: Excel
 * guarda la fecha como Date y el importe como number, y el lector de ARCA
 * espera lo que el operador VE en la planilla.
 *
 * - Las fechas se escriben `dd/mm/aaaa`, que es lo que `parsearFechaArg`
 *   entiende y lo que muestra Excel en una planilla argentina.
 * - Los números se escriben con punto decimal y SIN separador de miles.
 *   `parsearImporte` lo interpreta bien ("534043.77") y evita el riesgo
 *   de que `toLocaleString` meta un separador que después haya que
 *   desarmar.
 * - Una fórmula aporta su RESULTADO, no su texto.
 */
function aTexto(valor: ExcelJS.CellValue): string {
  if (valor === null || valor === undefined) return ''
  if (valor instanceof Date) {
    const dd = String(valor.getDate()).padStart(2, '0')
    const mm = String(valor.getMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${valor.getFullYear()}`
  }
  if (typeof valor === 'number') return String(valor)
  if (typeof valor === 'boolean') return valor ? 'true' : 'false'
  if (typeof valor === 'string') return valor

  // Los objetos que usa exceljs para celdas no triviales.
  const o = valor as unknown as Record<string, unknown>
  if ('result' in o) return aTexto(o.result as ExcelJS.CellValue)
  if ('text' in o) return String(o.text)
  if ('richText' in o) {
    return (o.richText as { text: string }[]).map((t) => t.text).join('')
  }
  if ('hyperlink' in o && 'text' in o) return String(o.text)
  return ''
}

/**
 * Las filas de la PRIMERA hoja. ARCA exporta una sola; si trajera varias,
 * tomar la primera es lo mismo que haría quien abre el archivo.
 *
 * No lanza por un archivo que no es XLSX: devuelve el error para que la
 * pantalla lo muestre, igual que hace el lector de CSV.
 */
export async function filasDesdeXlsx(
  datos: Buffer,
): Promise<{ ok: true; filas: string[][] } | { ok: false; error: string }> {
  try {
    const libro = new ExcelJS.Workbook()
    await libro.xlsx.load(datos as unknown as ArrayBuffer)

    const hoja = libro.worksheets[0]
    if (!hoja) return { ok: false, error: 'El archivo de Excel no tiene ninguna hoja.' }

    const filas: string[][] = []
    hoja.eachRow({ includeEmpty: false }, (fila) => {
      const celdas: string[] = []
      // `eachCell` con includeEmpty mantiene las posiciones: sin eso, una
      // celda vacía en el medio correría todas las columnas siguientes y
      // el mapeo por índice leería la columna equivocada.
      fila.eachCell({ includeEmpty: true }, (celda) => {
        celdas.push(aTexto(celda.value))
      })
      filas.push(celdas)
    })

    if (filas.length === 0) return { ok: false, error: 'La hoja de Excel está vacía.' }
    return { ok: true, filas }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `No se pudo leer el archivo de Excel: ${m.slice(0, 200)}` }
  }
}
