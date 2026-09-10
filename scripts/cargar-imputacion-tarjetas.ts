/**
 * Carga la tabla de imputación de impuestos que armó el usuario
 * (2026-09-10): el rótulo tal como sale impreso en cada liquidación, y a qué
 * código de Tango va.
 *
 * Son 48 filas de 9 proveedores, identificados por el CUIT que trae el
 * comprobante. Se guardan en `PHF_ALICUOTA_PROVEEDOR`, la misma tabla donde
 * la app aprende cuando el operador corrige una línea a mano: esto es
 * exactamente eso, pero cargado de una vez en vez de comprobante a
 * comprobante.
 *
 * Las de CPA18 (percepciones e impuestos varios) se cargan en las DOS
 * familias -- decisión del usuario. Un mismo rótulo puede caer en `percepN`
 * o en `variosN` según lo que decida la IA ese día, y el aprendizaje se
 * consulta por familia: cargándolo en las dos, aplica caiga donde caiga. No
 * tiene efecto secundario, porque solo se consulta la familia donde la línea
 * efectivamente esté.
 *
 * Es idempotente: `aprenderImpuestoEn` hace MERGE por (proveedor, tipo,
 * descripción), así que correrlo dos veces actualiza en vez de duplicar.
 *
 *   pnpm tsx scripts/cargar-imputacion-tarjetas.ts
 */
import { config as cargarEnv } from 'dotenv'
cargarEnv({ path: '.env.local' })

import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'
import { aprenderImpuestoEn } from '../src/server/app/aprendizajeImpuestos'
import { listarCodigosImpuesto } from '../src/server/tango/impuestos'

/** [CUIT del comprobante, rótulo impreso, código de Tango]. */
const TABLA: [string, string, string][] = [
  ['30-68537634-9', 'IVA', '1'],
  ['30-68537634-9', 'Percepción de IVA', '16'],
  ['30-68537634-9', 'Percepción sobre Débitos/Créditos', '65'],
  ['30-68537634-9', 'Retención Ingresos Brutos Tucuman', '63'],
  ['30-68537634-9', 'Sirtac', '64'],
  ['30-68537634-9', 'Retención T.E.M. TUCUMAN', '56'],

  ['30-57142135-2', 'IVA S/ARANCEL + COSTO FINANCIERO', '1'],
  ['30-57142135-2', 'RETENCION IIBB SIRTAC', '64'],
  ['30-57142135-2', 'RETENCION DE INGRESOS BR', '63'],

  ['33-68666464-9', 'IVA', '1'],
  ['33-68666464-9', 'Retención IVA', '17'],
  ['33-68666464-9', 'Retención ganacias', '53'],
  ['33-68666464-9', 'Retencion I.B. /SIRTAC', '64'],
  ['33-68666464-9', 'Trib. emerg. munic.', '56'],

  ['30-68570941-0', 'IVA', '1'],
  ['30-68570941-0', 'Retención Iva Resolución General Nº 140', '17'],
  ['30-68570941-0', 'Retención Ganancias Resolución General Nº 3311', '53'],
  ['30-68570941-0', 'Retención Ingresos Brutos', '63'],
  ['30-68570941-0', 'Retención TEM', '56'],
  ['30-68570941-0', 'Régimen de Retención SIRTAC', '64'],

  ['30-52940352-2', 'REGIMEN DE RET.SIRTAC', '64'],
  ['30-52940352-2', 'T.E.M. - S.M.TUCUMAN', '56'],
  ['30-52940352-2', 'IMPUESTO AL DEBITO', '65'],
  ['30-52940352-2', 'RET. IMP. A LAS GANANCIAS', '53'],
  ['30-52940352-2', 'IVA 21% DEC 879', '1'],
  ['30-52940352-2', 'PERCEP. IVA RES. GRAL. 3337', '16'],
  ['30-52940352-2', 'IVA 10,5% DEC 879', '3'],
  ['30-52940352-2', 'RET. IMP S/ ING. BRUTOS', '63'],

  // Los cuatro bancos comparten el mismo juego de rotulos.
  ...['30-50001008-4', '30-99903208-3', '30-50000173-5', '30-50000319-3'].flatMap(
    (cuit): [string, string, string][] => [
      [cuit, 'IVA 21,00 %', '1'],
      [cuit, 'IVA 10,50 % Ley 25.063', '3'],
      [cuit, 'Ret.IB SIRTAC 2,00%', '64'],
      [cuit, 'Ret.IB TUCUMAN 5,00 %', '63'],
      [cuit, 'Percep./Retenc.AFIP - DGI', '16'],
    ],
  ),
]

async function main() {
  const pool = await getPool()

  // Los codigos TIPO_ALI='IV' van a los slots de IVA de la cabecera (CPA04)
  // y el resto a CPA18: de eso depende en que familia se aprende cada fila.
  const deCpa18 = new Set((await listarCodigosImpuesto()).map((c) => String(c.codigo)))

  const proveedores = new Map<string, string>()
  for (const [cuit] of TABLA) {
    if (proveedores.has(cuit)) continue
    const r = await pool
      .request()
      .input('c', sql.VarChar(20), cuit.replace(/\D/g, ''))
      .query<{ cod: string }>(`
        SELECT LTRIM(RTRIM(COD_PROVEE)) AS cod FROM CPA01
        WHERE REPLACE(REPLACE(LTRIM(RTRIM(ISNULL(N_CUIT,''))),'-',''),' ','') = @c`)
    if (r.recordset.length !== 1) {
      throw new Error(`El CUIT ${cuit} resuelve a ${r.recordset.length} proveedores, no a uno.`)
    }
    proveedores.set(cuit, r.recordset[0].cod)
  }

  let escritas = 0
  for (const [cuit, rotulo, cod] of TABLA) {
    const prov = proveedores.get(cuit)!
    const tipos = deCpa18.has(cod) ? (['percepcion', 'varios'] as const) : (['iva'] as const)
    for (const tipo of tipos) {
      await conTransaccion((tx) => aprenderImpuestoEn(tx, prov, tipo, rotulo, cod))
      escritas += 1
    }
  }

  console.log(`${TABLA.length} filas de la tabla -> ${escritas} filas aprendidas.`)
  console.log(`${proveedores.size} proveedores: ${[...proveedores.values()].join(', ')}`)
  await cerrarPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
