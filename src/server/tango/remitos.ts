import sql from 'mssql'
import { getPool } from '../db/pool'

export type RenglonRemito = {
  nRenglon: number
  codArticulo: string
  descripcion: string | null
  codDeposito: string | null
  cantidad: number
  cantidadFacturada: number
  cantidadPendiente: number
  precio: number
}

export type RemitoPendiente = {
  numeroInterno: string
  numero: string
  fecha: Date | null
  codProvee: string
  renglones: RenglonRemito[]
}

/**
 * Los remitos de proveedor son movimientos de stock, no comprobantes de
 * compra: la factura no da de alta stock, lo da de alta el remito. Viven en
 * STA14 (encabezado) y STA20 (renglones), con TCOMP_IN_S = 'RP'.
 *
 * Tres cosas verificadas contra la base que sostienen esta consulta:
 *
 * 1. `CANT_PEND` es la cantidad que Tango mantiene como pendiente de
 *    facturar. NO se puede derivar como CANTIDAD - CANT_FACTU - CANT_DEV:
 *    hay 380 renglones de RP donde esa resta da distinto. Se lee la columna.
 * 2. `ESTADO_MOV` de la cabecera y el saldo de los renglones no se
 *    contradicen: de los 3.662 remitos en 'F' no hay ni un renglon con
 *    saldo, y los 29 que tienen saldo cuelgan de remitos en 'P'. Aun asi se
 *    filtra por las dos cosas, porque hay remitos en 'P' con todos los
 *    renglones ya facturados y no son pendientes de nada.
 * 3. `PRECIO` viene en 0 en los 13.933 renglones de RP. El precio real esta
 *    en `PRECIO_REM`.
 */
const SELECT = `
  SELECT
    LTRIM(RTRIM(h.NCOMP_IN_S))            AS numeroInterno,
    LTRIM(RTRIM(ISNULL(h.N_COMP,'')))     AS numero,
    h.FECHA_MOV                           AS fecha,
    LTRIM(RTRIM(h.COD_PRO_CL))            AS codProvee,
    r.N_RENGL_S                           AS nRenglon,
    LTRIM(RTRIM(r.COD_ARTICU))            AS codArticulo,
    LTRIM(RTRIM(ISNULL(a.DESCRIPCIO,''))) AS descripcion,
    LTRIM(RTRIM(ISNULL(r.COD_DEPOSI,''))) AS codDeposito,
    r.CANTIDAD                            AS cantidad,
    r.CANT_FACTU                          AS cantidadFacturada,
    r.CANT_PEND                           AS cantidadPendiente,
    r.PRECIO_REM                          AS precio
  FROM STA14 h
  JOIN STA20 r
    ON r.TCOMP_IN_S = h.TCOMP_IN_S
   AND r.NCOMP_IN_S = h.NCOMP_IN_S
  LEFT JOIN STA11 a
    ON a.COD_ARTICU = r.COD_ARTICU
  WHERE h.TCOMP_IN_S = 'RP'
    AND h.ESTADO_MOV = 'P'
    AND r.CANT_PEND > 0
`

/**
 * Los remitos del proveedor que todavia tienen mercaderia sin facturar, con
 * sus renglones pendientes. Un remito sin ningun renglon pendiente no
 * aparece. Los renglones ya facturados de un remito que sigue pendiente
 * tampoco: el operador solo puede asociar lo que queda.
 */
export async function buscarRemitosPendientes(codProvee: string): Promise<RemitoPendiente[]> {
  const cod = codProvee.trim()
  if (!cod) return []

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), cod)
    .query<Record<string, unknown>>(`
      ${SELECT}
        AND h.COD_PRO_CL = @prov
      ORDER BY h.FECHA_MOV DESC, h.NCOMP_IN_S DESC, r.N_RENGL_S
    `)

  return agrupar(r.recordset)
}

function agrupar(filas: Record<string, unknown>[]): RemitoPendiente[] {
  const remitos: RemitoPendiente[] = []
  let actual: RemitoPendiente | null = null

  // Las filas vienen ordenadas por remito, asi que alcanza con cortar cuando
  // cambia el numero interno.
  for (const f of filas) {
    const numeroInterno = String(f.numeroInterno)
    if (!actual || actual.numeroInterno !== numeroInterno) {
      actual = {
        numeroInterno,
        numero: String(f.numero),
        fecha: f.fecha ? new Date(f.fecha as string) : null,
        codProvee: String(f.codProvee),
        renglones: [],
      }
      remitos.push(actual)
    }
    actual.renglones.push({
      nRenglon: Number(f.nRenglon),
      codArticulo: String(f.codArticulo),
      descripcion: f.descripcion ? String(f.descripcion) : null,
      codDeposito: f.codDeposito ? String(f.codDeposito) : null,
      cantidad: Number(f.cantidad),
      cantidadFacturada: Number(f.cantidadFacturada),
      cantidadPendiente: Number(f.cantidadPendiente),
      precio: Number(f.precio),
    })
  }

  return remitos
}

/**
 * Los renglones ACTUALES de un remito puntual, por su clave interna
 * (`NCOMP_IN_S`). A diferencia de `buscarRemitosPendientes`, no filtra por
 * saldo: sirve para refrescar un vínculo ya hecho aunque ese renglón del
 * remito ya esté completamente facturado en Tango, caso en el que
 * desaparecería de la lista de pendientes.
 *
 * No hace falta acotar por proveedor: `NCOMP_IN_S` ya identifica un remito
 * puntual, viene de un vínculo que un renglón de esta app ya tiene guardado.
 */
export async function renglonesDelRemitoInterno(ncompInS: string): Promise<RenglonRemito[]> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('ncompInS', sql.VarChar(8), ncompInS)
    .query<Record<string, unknown>>(`
      SELECT
        r.N_RENGL_S                           AS nRenglon,
        LTRIM(RTRIM(r.COD_ARTICU))            AS codArticulo,
        LTRIM(RTRIM(ISNULL(a.DESCRIPCIO,''))) AS descripcion,
        LTRIM(RTRIM(ISNULL(r.COD_DEPOSI,''))) AS codDeposito,
        r.CANTIDAD                            AS cantidad,
        r.CANT_FACTU                          AS cantidadFacturada,
        r.CANT_PEND                           AS cantidadPendiente,
        r.PRECIO_REM                          AS precio
      FROM STA20 r
      LEFT JOIN STA11 a ON a.COD_ARTICU = r.COD_ARTICU
      WHERE r.TCOMP_IN_S = 'RP' AND r.NCOMP_IN_S = @ncompInS
      ORDER BY r.N_RENGL_S
    `)

  return r.recordset.map((f) => ({
    nRenglon: Number(f.nRenglon),
    codArticulo: String(f.codArticulo),
    descripcion: f.descripcion ? String(f.descripcion) : null,
    codDeposito: f.codDeposito ? String(f.codDeposito) : null,
    cantidad: Number(f.cantidad),
    cantidadFacturada: Number(f.cantidadFacturada),
    cantidadPendiente: Number(f.cantidadPendiente),
    precio: Number(f.precio),
  }))
}

/**
 * El numero de remito tal como lo guarda Tango: `R` + punto de venta (5) +
 * numero (8), en CHAR(14). Ejemplo: "R0000100029869" es el 00001-00029869.
 *
 * `N_REMITO` existe en STA14 y seria el candidato obvio por el nombre, pero
 * esta vacia en los 3.940 remitos de la base: el numero vive en N_COMP.
 */
const LARGO_PTOVTA = 5
const LARGO_NUMERO = 8

export type NumeroRemito = { ptovta: string; numero: string }

/**
 * Lleva a la forma de Tango lo que la IA leyo del PDF. El proveedor lo
 * imprime como se le ocurre -- "Remito 0001-00029869", "R 1-29869",
 * "0001 00029869" -- asi que se trabaja solo con los digitos.
 *
 * Devuelve null si no hay digitos suficientes para armar un numero: mejor
 * no buscar que buscar cualquier cosa.
 */
export function normalizarNumeroRemito(texto: string | null | undefined): NumeroRemito | null {
  const t = (texto ?? '').trim()
  if (t === '') return null

  // Con separador entre las dos partes, cada una se rellena por su cuenta.
  // Es el unico camino que sirve para el proveedor que imprime "1-29869"
  // sin ceros: ahi no alcanza con tomar los ultimos ocho digitos, porque no
  // hay ocho. Se ancla al final para no engancharse con una fecha o un
  // numero de orden que venga antes en el mismo texto.
  // El (?<!\d) es lo que hace que un punto de venta de mas de 5 digitos se
  // rechace en vez de recortarse: sin el, "1234567-00029869" matchearia
  // tomando los ultimos 5 y devolveria un remito que no es.
  const partido = /(?<!\d)(\d{1,5})\s*[-/\s]\s*(\d{1,8})\s*$/.exec(t)
  if (partido) {
    return {
      ptovta: partido[1].padStart(LARGO_PTOVTA, '0'),
      numero: partido[2].padStart(LARGO_NUMERO, '0'),
    }
  }

  // Sin separador: los ultimos 8 digitos son el numero y lo de adelante el
  // punto de venta.
  const digitos = t.replace(/\D/g, '')
  if (digitos.length < LARGO_NUMERO) return null

  const numero = digitos.slice(-LARGO_NUMERO)
  const ptovta = digitos.slice(0, -LARGO_NUMERO).padStart(LARGO_PTOVTA, '0')
  if (ptovta.length > LARGO_PTOVTA) return null

  return { ptovta, numero }
}

export type RemitoBuscado =
  | { estado: 'encontrado'; remito: RemitoPendiente }
  /** Existe en Tango pero ya no tiene mercaderia sin facturar. */
  | { estado: 'sin-saldo'; numero: string }
  | { estado: 'no-existe'; numero: string }

/**
 * Busca un remito del proveedor por el numero que la IA leyo de la factura.
 *
 * Se acota al proveedor a proposito: el mismo numero impreso puede repetirse
 * entre proveedores distintos -- el punto de venta es de ellos, no nuestro --
 * y traer el remito de otro proveedor seria peor que no traer nada.
 *
 * Distingue "no existe" de "existe pero sin saldo" porque son dos problemas
 * distintos para el operador: el primero suele ser un numero mal leido, el
 * segundo una factura que repite mercaderia ya facturada.
 */
export async function buscarRemitoPorNumero(
  codProvee: string,
  numeroLeido: string,
): Promise<RemitoBuscado> {
  const cod = codProvee.trim()
  const partido = normalizarNumeroRemito(numeroLeido)
  if (!cod || !partido) return { estado: 'no-existe', numero: numeroLeido }

  const exacto = `R${partido.ptovta}${partido.numero}`
  // El primer digito del numero (el que sigue al punto de venta) no es
  // confiable: un remito real de Topper (proveedor 010685) lo prueba -- el
  // PDF imprime "5026-00530766" y Tango lo tiene guardado como
  // "R0502610530766", identico salvo ese primer digito del numero. Se
  // busca con ese digito como comodin y, si hay mas de un match, se
  // prefiere el exacto.
  const patron = `R${partido.ptovta}_${partido.numero.slice(1)}`

  const pool = await getPool()
  const r = await pool
    .request()
    .input('prov', sql.VarChar(6), cod)
    .input('patron', sql.VarChar(14), patron)
    .input('exacto', sql.VarChar(14), exacto)
    .query<Record<string, unknown>>(`
      ${SELECT}
        AND h.COD_PRO_CL = @prov
        AND LTRIM(RTRIM(h.N_COMP)) LIKE @patron
      ORDER BY CASE WHEN LTRIM(RTRIM(h.N_COMP)) = @exacto THEN 0 ELSE 1 END,
               h.NCOMP_IN_S, r.N_RENGL_S
    `)

  const remitos = agrupar(r.recordset)
  if (remitos.length > 0) return { estado: 'encontrado', remito: remitos[0] }

  // Sin renglones pendientes: puede ser que el remito no exista o que ya
  // este facturado. Se pregunta sin los filtros de saldo para saber cual.
  const existe = await pool
    .request()
    .input('prov', sql.VarChar(6), cod)
    .input('patron', sql.VarChar(14), patron)
    .query(`
      SELECT TOP 1 1 AS hay FROM STA14
      WHERE TCOMP_IN_S = 'RP' AND COD_PRO_CL = @prov AND LTRIM(RTRIM(N_COMP)) LIKE @patron
    `)

  return existe.recordset.length > 0
    ? { estado: 'sin-saldo', numero: exacto }
    : { estado: 'no-existe', numero: numeroLeido }
}
