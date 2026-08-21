import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, type RenglonGuardado } from '@/server/app/detalle'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { parsearImporte } from '@/lib/formato'
import { listarAlicuotasIva, listarCodigosImpuesto } from './impuestos'
import { conceptoDelComprobante } from './conceptos'

/**
 * Simula, de solo lectura, el asiento contable que Tango generaria al
 * registrar un comprobante -- sin escribir nada, ni en PHF_* ni en el ERP.
 * El asiento real lo genera un proceso aparte de Tango cuando contabiliza
 * (`ASIENTO_COMPROBANTE_CP`, fuera de alcance -- ver el spec original §2);
 * esto es una vista previa para el operador, calculada desde las tablas de
 * configuracion del motor de asientos.
 *
 * Excepcion documentada en CLAUDE.md (2026-08-20/21): TIPO_CONTABLE, CUENTA
 * y ASIENTO_MODELO_CP no figuran en la documentacion de Axoft para Compras
 * ni Stock, pero son tablas de configuracion real -- no espejos CTA* -- y
 * estan autorizadas de solo lectura.
 */

/** El unico modelo que pidio el usuario: "FACTURAS / NOTAS DE DEBITO". */
const ID_ASIENTO_MODELO_CP = 1

export type RenglonModelo = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  dh: 'D' | 'H'
  /** Si esta cuenta se puede reemplazar por la del concepto o el articulo. */
  reemplazaCuenta: boolean
}

/**
 * El modelo de asiento 1, indexado por `TIPO_CONTABLE.COD_TIPO_CONTABLE`.
 * Ese codigo es la clave: para IVA (`1`-`4`) y percepcion IIBB (`60`,`61`,
 * `62`,`68`, entre otros) son los MISMOS codigos de CPA14 que ya resuelven
 * `resolverAlicuotas`/`resolverPercepciones`/`resolverVarios` -- no hace
 * falta ningun mapeo nuevo, se busca directo por ese codigo.
 */
export async function cargarModeloAsiento(): Promise<Map<string, RenglonModelo>> {
  const pool = await getPool()
  const r = await pool
    .request()
    .input('idModelo', sql.Int, ID_ASIENTO_MODELO_CP)
    .query<Record<string, unknown>>(`
      SELECT
        t.COD_TIPO_CONTABLE                                     AS codTipoContable,
        c.COD_CUENTA                                             AS codCuenta,
        LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,'')))                   AS descCuenta,
        LTRIM(RTRIM(ISNULL(r.DESC_LEYENDA_RENGLON, t.DESC_TIPO_CONTABLE))) AS leyenda,
        r.D_H                                                    AS dh,
        r.REEMPLAZA_CUENTA                                       AS reemplazaCuenta
      FROM RENGLON_MODELO_CP r
      JOIN TIPO_CONTABLE t ON t.ID_TIPO_CONTABLE = r.ID_TIPO_CONTABLE
      JOIN CUENTA c ON c.ID_CUENTA = r.ID_CUENTA
      WHERE r.ID_ASIENTO_MODELO_CP = @idModelo
    `)

  const modelo = new Map<string, RenglonModelo>()
  for (const f of r.recordset) {
    modelo.set(String(f.codTipoContable).trim(), {
      codCuenta: String(f.codCuenta).trim(),
      descCuenta: String(f.descCuenta),
      leyenda: String(f.leyenda),
      dh: f.dh === 'H' ? 'H' : 'D',
      reemplazaCuenta: f.reemplazaCuenta === 'S',
    })
  }
  return modelo
}

export type CuentaContable = { codCuenta: string; descCuenta: string }

/**
 * La cuenta que reemplaza a Subtotal gravado/exento cuando el comprobante
 * es de conceptos o de tarjeta. `CPA45.COD_CONCEP` es el mismo codigo que
 * ya resuelve `buscarConceptoProveedor`/`buscarConceptoTarjeta`
 * (`src/server/tango/conceptos.ts`); el join a `CONCEPTO_CP` va por
 * `ID_CPA45`, no por el codigo de texto.
 */
export async function cuentaDelConcepto(codConcepto: string): Promise<CuentaContable | null> {
  const cod = codConcepto.trim()
  if (!cod) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cod', sql.VarChar(3), cod)
    .query<Record<string, unknown>>(`
      SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
      FROM CPA45 cp45
      JOIN CONCEPTO_CP cc ON cc.ID_CPA45 = cp45.ID_CPA45
      JOIN CUENTA c ON c.ID_CUENTA = cc.ID_CUENTA
      WHERE LTRIM(RTRIM(cp45.COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const f = r.recordset[0]
  return { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) }
}

/**
 * La cuenta de compras de cada articulo, para reemplazar Subtotal gravado
 * en facturas de articulos. Una query por codigo (la lista es a lo sumo
 * los articulos distintos de un comprobante, tipicamente unos pocos) en
 * vez de un IN dinamico: mas simple y sigue parametrizado.
 */
export async function cuentasDeArticulos(codigos: string[]): Promise<Map<string, CuentaContable>> {
  const mapa = new Map<string, CuentaContable>()
  if (codigos.length === 0) return mapa

  const pool = await getPool()
  for (const codigo of codigos) {
    const r = await pool
      .request()
      .input('cod', sql.VarChar(15), codigo)
      .query<Record<string, unknown>>(`
        SELECT c.COD_CUENTA AS codCuenta, LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
        FROM ARTICULO_CUENTA ac
        JOIN CUENTA c ON c.ID_CUENTA = ac.ID_CUENTA_COMPRAS
        WHERE LTRIM(RTRIM(ac.COD_STA11)) = @cod
      `)
    if (r.recordset.length > 0) {
      const f = r.recordset[0]
      mapa.set(codigo, { codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) })
    }
  }
  return mapa
}

export type Ejecutor = { request(): sql.Request }

export type LineaAsiento = {
  codCuenta: string
  descCuenta: string
  leyenda: string
  debe: number
  haber: number
}

export type AsientoPreview = {
  lineas: LineaAsiento[]
  totalDebe: number
  totalHaber: number
  balanceado: boolean
  /** Cuantas lineas de impuestos no se pudieron mostrar por falta de un
   * codigo de Tango resuelto (jurisdiccion no reconocida, codigo elegido
   * que ya no existe). Sirve para que el modal no le eche la culpa del
   * desbalance a "revisa los importes" cuando el problema es otro. */
  lineasOmitidas: number
}

/**
 * Agrupa los renglones de una factura de articulos por la cuenta de
 * compras que le resuelve ARTICULO_CUENTA, sumando el importe de cada
 * grupo -- una linea de Debe por cada cuenta distinta que aparezca (caso
 * dominante: un solo grupo, 9.059/9.060 articulos comparten la cuenta
 * 120). Si un articulo no tiene ARTICULO_CUENTA cargada, cae a la cuenta
 * de Subtotal gravado del modelo -- mejor mostrar el fallback que romper
 * la vista previa.
 */
async function agruparRenglonesPorCuenta(
  renglones: RenglonGuardado[],
  sb: RenglonModelo | undefined,
): Promise<{ cuenta: CuentaContable; importe: number }[]> {
  const codigos = [
    ...new Set(
      renglones
        .map((r) => r.codigoFinal?.trim() || r.codigo?.trim())
        .filter((c): c is string => Boolean(c)),
    ),
  ]
  const cuentasPorArticulo = await cuentasDeArticulos(codigos)
  const fallback: CuentaContable | null = sb ? { codCuenta: sb.codCuenta, descCuenta: sb.descCuenta } : null

  const porCuenta = new Map<string, { cuenta: CuentaContable; importe: number }>()
  for (const r of renglones) {
    const codigo = r.codigoFinal?.trim() || r.codigo?.trim()
    const importe = parsearImporte(r.importe)
    if (!codigo || importe <= 0) continue

    const cuenta = cuentasPorArticulo.get(codigo) ?? fallback
    if (!cuenta) continue

    const acumulado = porCuenta.get(cuenta.codCuenta)
    if (acumulado) acumulado.importe = Math.round((acumulado.importe + importe) * 100) / 100
    else porCuenta.set(cuenta.codCuenta, { cuenta, importe })
  }
  return [...porCuenta.values()]
}

/**
 * La cuenta final para una linea de SB/EX: si el renglon del modelo no
 * permite reemplazo (`REEMPLAZA_CUENTA = 'N'`), siempre gana la cuenta del
 * modelo, sin importar lo que haya resuelto el concepto o los articulos.
 */
function cuentaFinal(renglon: RenglonModelo, override: CuentaContable | null): CuentaContable {
  if (!renglon.reemplazaCuenta) return { codCuenta: renglon.codCuenta, descCuenta: renglon.descCuenta }
  return override ?? { codCuenta: renglon.codCuenta, descCuenta: renglon.descCuenta }
}

/**
 * Arma la vista previa completa. No bloquea por datos faltantes o
 * codigos sin resolver -- a diferencia de `registrarComprobanteEn`, que
 * tiene que ser estricto porque escribe en Tango, esto es una vista
 * previa: una linea que no se puede resolver simplemente no aparece.
 */
export async function previsualizarAsientoEn(e: Ejecutor, comprobanteId: number): Promise<AsientoPreview> {
  const [modelo, detalle] = await Promise.all([
    cargarModeloAsiento(),
    obtenerDetalleEn(e, comprobanteId),
  ])

  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const tipoFactura = valores.tipoFactura ?? null
  const codProvee = (valores.codprovee ?? '').trim() || null

  const lineas: LineaAsiento[] = []

  // --- Subtotal gravado (SB) y exento (EX): la cuenta se puede reemplazar. ---
  const sb = modelo.get('SB')
  const ex = modelo.get('EX')
  const neto = parsearImporte(valores.neto)
  const exento = parsearImporte(valores.exento)

  let cuentaSubtotal: CuentaContable | null = null
  let gruposArticulo: { cuenta: CuentaContable; importe: number }[] = []

  if (tipoFactura === 'conceptos' || tipoFactura === 'tarjeta') {
    const concepto = await conceptoDelComprobante(tipoFactura, codProvee)
    cuentaSubtotal = concepto ? await cuentaDelConcepto(concepto.codConcepto) : null
  } else if (tipoFactura === 'articulos') {
    gruposArticulo = await agruparRenglonesPorCuenta(detalle.renglones, sb)
    if (gruposArticulo.length > 0) {
      cuentaSubtotal = gruposArticulo.reduce((a, b) => (b.importe > a.importe ? b : a)).cuenta
    }
  }

  if (sb && neto > 0) {
    if (sb.reemplazaCuenta && gruposArticulo.length > 0) {
      // Se prorratea el neto de cabecera entre las cuentas distintas que
      // resolvieron los renglones, en vez de sumar IMPORTE_IA directo: la
      // suma de renglones puede no coincidir centavo a centavo con el neto
      // (la tarjeta de renglones ya expone y tolera esa diferencia -- ver
      // "Subtotal renglones" en renglones.tsx). Si el asiento usara la
      // suma de renglones, "balanceado" terminaria comparando dos cosas
      // distintas y diria "no cierra" para una factura que esta bien. El
      // ultimo grupo absorbe el resto del redondeo para que la suma sea
      // exacta.
      const sumaGrupos = gruposArticulo.reduce((acc, g) => acc + g.importe, 0)
      let acumulado = 0
      gruposArticulo.forEach((g, i) => {
        const esUltimo = i === gruposArticulo.length - 1
        const parte = esUltimo
          ? Math.round((neto - acumulado) * 100) / 100
          : Math.round((neto * (g.importe / sumaGrupos)) * 100) / 100
        acumulado = Math.round((acumulado + parte) * 100) / 100
        lineas.push({ codCuenta: g.cuenta.codCuenta, descCuenta: g.cuenta.descCuenta, leyenda: sb.leyenda, debe: parte, haber: 0 })
      })
    } else {
      const cuenta = cuentaFinal(sb, cuentaSubtotal)
      lineas.push({ codCuenta: cuenta.codCuenta, descCuenta: cuenta.descCuenta, leyenda: sb.leyenda, debe: neto, haber: 0 })
    }
  }
  if (ex && exento > 0) {
    const cuenta = cuentaFinal(ex, cuentaSubtotal)
    lineas.push({ codCuenta: cuenta.codCuenta, descCuenta: cuenta.descCuenta, leyenda: ex.leyenda, debe: exento, haber: 0 })
  }

  // --- IVA, percepciones IIBB, impuestos varios: cuenta fija del modelo. ---
  const [alicuotas, codigosImpuesto] = await Promise.all([listarAlicuotasIva(), listarCodigosImpuesto()])
  const genericas = new Map<string, number>()
  let lineasOmitidas = 0

  for (const l of resolverAlicuotas(valores, alicuotas)) {
    if (l.estado === 'registra' && l.alicuota) {
      const cod = String(l.alicuota.codigo)
      genericas.set(cod, Math.round(((genericas.get(cod) ?? 0) + l.importe) * 100) / 100)
    } else if (l.estado === 'sin-codigo') {
      lineasOmitidas += 1
    }
  }
  for (const l of resolverPercepciones(valores, tipoFactura)) {
    if (l.estado === 'registra' && l.codigo) {
      genericas.set(l.codigo.codigo, Math.round(((genericas.get(l.codigo.codigo) ?? 0) + l.importe) * 100) / 100)
    } else if (l.estado === 'sin-codigo') {
      lineasOmitidas += 1
    }
  }
  for (const l of resolverVarios(valores, codigosImpuesto)) {
    if (l.estado === 'registra') {
      genericas.set(l.codigo, Math.round(((genericas.get(l.codigo) ?? 0) + l.importe) * 100) / 100)
    } else if (l.estado === 'sin-codigo') {
      lineasOmitidas += 1
    }
  }

  for (const [codTipo, importe] of genericas) {
    const renglon = modelo.get(codTipo)
    if (!renglon || importe <= 0) continue
    lineas.push({
      codCuenta: renglon.codCuenta,
      descCuenta: renglon.descCuenta,
      leyenda: renglon.leyenda,
      debe: renglon.dh === 'D' ? importe : 0,
      haber: renglon.dh === 'H' ? importe : 0,
    })
  }

  // --- Total del comprobante (TO): siempre Haber, cuenta del modelo. ---
  const to = modelo.get('TO')
  const total = parsearImporte(valores.total)
  if (to && total > 0) {
    lineas.push({ codCuenta: to.codCuenta, descCuenta: to.descCuenta, leyenda: to.leyenda, debe: 0, haber: total })
  }

  const totalDebe = Math.round(lineas.reduce((a, l) => a + l.debe, 0) * 100) / 100
  const totalHaber = Math.round(lineas.reduce((a, l) => a + l.haber, 0) * 100) / 100

  return {
    lineas,
    totalDebe,
    totalHaber,
    balanceado: Math.abs(totalDebe - totalHaber) < 0.01,
    lineasOmitidas,
  }
}

export async function previsualizarAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsientoEn(await getPool(), comprobanteId)
}
