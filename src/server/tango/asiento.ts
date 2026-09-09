import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, type RenglonGuardado } from '@/server/app/detalle'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { parsearImporte, totalImputado } from '@/lib/formato'
import { listarAlicuotasIva, listarCodigosImpuesto } from './impuestos'
import { conceptoDelComprobante } from './conceptos'
import { cargarAprendidosEn } from '@/server/app/aprendizajeImpuestos'
import { terminalActual } from '@/lib/usuario'

/**
 * Simula el asiento contable que Tango generaria al registrar un
 * comprobante, y lo deja armado en las tablas de staging que el propio
 * Tango lee para "pasar a contabilidad" (`escribirAsientoEn`, mas abajo).
 * No contabiliza: eso sigue siendo un proceso propio de Tango que corre el
 * usuario dentro del ERP -- esta app arma el asiento, no lo postea.
 *
 * Excepcion documentada en CLAUDE.md: TIPO_CONTABLE, CUENTA,
 * ASIENTO_MODELO_CP, RENGLON_MODELO_CP y CONCEPTO_CP (2026-08-20/21, solo
 * lectura) mas ASIENTO_COMPROBANTE_CP y ASIENTO_CP (2026-08-22, lectura y
 * escritura) no figuran en la documentacion de Axoft para Compras ni
 * Stock, pero son tablas reales del motor contable -- no espejos CTA* --
 * y estan autorizadas por decision explicita del usuario.
 */

/** El unico modelo que pidio el usuario: "FACTURAS / NOTAS DE DEBITO". */
const ID_ASIENTO_MODELO_CP = 1

/** ASIENTO_CP.DESC_LEYENDA es VARCHAR(100) -- verificado contra la base real. */
const LARGO_LEYENDA = 100

export type RenglonModelo = {
  idCuenta: number
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
        c.ID_CUENTA                                              AS idCuenta,
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
      idCuenta: Number(f.idCuenta),
      codCuenta: String(f.codCuenta).trim(),
      descCuenta: String(f.descCuenta),
      leyenda: String(f.leyenda),
      dh: f.dh === 'H' ? 'H' : 'D',
      reemplazaCuenta: f.reemplazaCuenta === 'S',
    })
  }
  return modelo
}

export type CuentaContable = { idCuenta: number; codCuenta: string; descCuenta: string }

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
      SELECT c.ID_CUENTA AS idCuenta, c.COD_CUENTA AS codCuenta,
             LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
      FROM CPA45 cp45
      JOIN CONCEPTO_CP cc ON cc.ID_CPA45 = cp45.ID_CPA45
      JOIN CUENTA c ON c.ID_CUENTA = cc.ID_CUENTA
      WHERE LTRIM(RTRIM(cp45.COD_CONCEP)) = @cod
    `)

  if (r.recordset.length === 0) return null
  const f = r.recordset[0]
  return { idCuenta: Number(f.idCuenta), codCuenta: String(f.codCuenta).trim(), descCuenta: String(f.descCuenta) }
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
        SELECT c.ID_CUENTA AS idCuenta, c.COD_CUENTA AS codCuenta,
               LTRIM(RTRIM(ISNULL(c.DESC_CUENTA,''))) AS descCuenta
        FROM ARTICULO_CUENTA ac
        JOIN CUENTA c ON c.ID_CUENTA = ac.ID_CUENTA_COMPRAS
        WHERE LTRIM(RTRIM(ac.COD_STA11)) = @cod
      `)
    if (r.recordset.length > 0) {
      const f = r.recordset[0]
      mapa.set(codigo, {
        idCuenta: Number(f.idCuenta),
        codCuenta: String(f.codCuenta).trim(),
        descCuenta: String(f.descCuenta),
      })
    }
  }
  return mapa
}

export type Ejecutor = { request(): sql.Request }

export type LineaAsiento = {
  idCuenta: number
  codCuenta: string
  descCuenta: string
  leyenda: string
  debe: number
  haber: number
  /** Si la cuenta de esta linea admite reemplazo (por concepto o articulo)
   *  en el modelo de Tango -- lo mismo que graba ASIENTO_CP.EDITA_CUENTA,
   *  no si en este comprobante puntual se reemplazo de verdad. */
  editaCuenta: boolean
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
  const fallback: CuentaContable | null = sb
    ? { idCuenta: sb.idCuenta, codCuenta: sb.codCuenta, descCuenta: sb.descCuenta }
    : null

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
  const propia = { idCuenta: renglon.idCuenta, codCuenta: renglon.codCuenta, descCuenta: renglon.descCuenta }
  if (!renglon.reemplazaCuenta) return propia
  return override ?? propia
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

  // Lo que este proveedor ya le enseñó a la app para IVA e IIBB -- mismo
  // criterio que "listo para registrar" y el registro real, para que la
  // vista previa nunca resuelva distinto.
  //
  // Secuencial y no Promise.all: `e` puede ser una sql.Transaction (lo es
  // acá, dentro de conRollback), y mssql no soporta dos pedidos en vuelo
  // sobre la misma transacción -- lanzarlos en paralelo cuelga la conexión
  // en vez de fallar, y arrastra a cualquier otra sesión que espere un
  // lock de esta misma transacción. Se reprodujo en vivo corriendo la
  // suite de tests.
  const aprendidosIva = codProvee ? await cargarAprendidosEn(e, codProvee, 'iva') : {}
  const aprendidosPercep = codProvee ? await cargarAprendidosEn(e, codProvee, 'percepcion') : {}
  const aprendidosVarios = codProvee ? await cargarAprendidosEn(e, codProvee, 'varios') : {}

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
        lineas.push({
          idCuenta: g.cuenta.idCuenta,
          codCuenta: g.cuenta.codCuenta,
          descCuenta: g.cuenta.descCuenta,
          leyenda: sb.leyenda,
          debe: parte,
          haber: 0,
          editaCuenta: sb.reemplazaCuenta,
        })
      })
    } else {
      const cuenta = cuentaFinal(sb, cuentaSubtotal)
      lineas.push({
        idCuenta: cuenta.idCuenta,
        codCuenta: cuenta.codCuenta,
        descCuenta: cuenta.descCuenta,
        leyenda: sb.leyenda,
        debe: neto,
        haber: 0,
        editaCuenta: sb.reemplazaCuenta,
      })
    }
  }
  if (ex && exento > 0) {
    const cuenta = cuentaFinal(ex, cuentaSubtotal)
    lineas.push({
      idCuenta: cuenta.idCuenta,
      codCuenta: cuenta.codCuenta,
      descCuenta: cuenta.descCuenta,
      leyenda: ex.leyenda,
      debe: exento,
      haber: 0,
      editaCuenta: ex.reemplazaCuenta,
    })
  }

  // --- IVA, percepciones IIBB, impuestos varios: cuenta fija del modelo. ---
  const [alicuotas, codigosImpuesto] = await Promise.all([listarAlicuotasIva(), listarCodigosImpuesto()])
  const genericas = new Map<string, number>()
  let lineasOmitidas = 0

  for (const l of resolverAlicuotas(valores, alicuotas, aprendidosIva)) {
    if (l.estado === 'registra' && l.alicuota) {
      const cod = String(l.alicuota.codigo)
      genericas.set(cod, Math.round(((genericas.get(cod) ?? 0) + l.importe) * 100) / 100)
    } else if (l.estado === 'sin-codigo') {
      lineasOmitidas += 1
    }
  }
  for (const l of resolverPercepciones(valores, tipoFactura, aprendidosPercep, codigosImpuesto)) {
    if (l.estado === 'registra' && l.codigo) {
      genericas.set(l.codigo.codigo, Math.round(((genericas.get(l.codigo.codigo) ?? 0) + l.importe) * 100) / 100)
    } else if (l.estado === 'sin-codigo') {
      lineasOmitidas += 1
    }
  }
  for (const l of resolverVarios(valores, codigosImpuesto, aprendidosVarios)) {
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
      idCuenta: renglon.idCuenta,
      codCuenta: renglon.codCuenta,
      descCuenta: renglon.descCuenta,
      leyenda: renglon.leyenda,
      debe: renglon.dh === 'D' ? importe : 0,
      haber: renglon.dh === 'H' ? importe : 0,
      editaCuenta: renglon.reemplazaCuenta,
    })
  }

  // --- Total del comprobante (TO): siempre Haber, cuenta del modelo. ---
  const to = modelo.get('TO')
  // En tarjeta el total impreso sale por diferencia y no es confiable --
  // mismo criterio y misma funcion que registrarComprobanteEn, para que la
  // vista previa nunca pueda mostrar un total distinto del que se graba.
  const total = tipoFactura === 'tarjeta' ? totalImputado(valores) : parsearImporte(valores.total)
  if (to && total > 0) {
    lineas.push({
      idCuenta: to.idCuenta,
      codCuenta: to.codCuenta,
      descCuenta: to.descCuenta,
      leyenda: to.leyenda,
      debe: 0,
      haber: total,
      editaCuenta: to.reemplazaCuenta,
    })
  }

  // Texto libre del operador (campo "Leyenda / observación del asiento"):
  // REEMPLAZA la leyenda de cada renglón, no se le agrega (decisión
  // explícita del usuario, 2026-09-03 -- antes se concatenaba a la del
  // modelo). Cuando el operador carga una leyenda, es la única que queda:
  // las 5 o 6 líneas del asiento dicen todas lo mismo, que es como el
  // usuario quiere leerlo en Tango. Sin leyenda cargada, cada línea
  // conserva la del modelo contable ("Subtotal gravado", "IVA 21%"...).
  //
  // Se trunca acá, no solo al escribir en escribirAsientoEn, para que la
  // vista previa ("Ver asiento") muestre exactamente el texto que va a
  // quedar grabado en ASIENTO_CP.DESC_LEYENDA (VARCHAR(100)).
  const observacion = (valores.leyendaAsiento ?? '').trim()
  const lineasConLeyenda = observacion
    ? lineas.map((l) => ({ ...l, leyenda: observacion.slice(0, LARGO_LEYENDA) }))
    : lineas

  const totalDebe = Math.round(lineas.reduce((a, l) => a + l.debe, 0) * 100) / 100
  const totalHaber = Math.round(lineas.reduce((a, l) => a + l.haber, 0) * 100) / 100

  return {
    lineas: lineasConLeyenda,
    totalDebe,
    totalHaber,
    balanceado: Math.abs(totalDebe - totalHaber) < 0.01,
    lineasOmitidas,
  }
}

export async function previsualizarAsiento(comprobanteId: number): Promise<AsientoPreview> {
  return previsualizarAsientoEn(await getPool(), comprobanteId)
}

/**
 * Arma el asiento real en las tablas de staging que Tango lee para "pasar
 * a contabilidad": `ASIENTO_COMPROBANTE_CP` (encabezado, uno por
 * comprobante) y `ASIENTO_CP` (un renglon por linea de Debe/Haber).
 *
 * Queda contabilizado (`CONTABILIZADO='S'`) al momento de grabarse --
 * decision explicita del usuario, 2026-08-22. `USUARIO_CONTABILIZACION`
 * queda en `'PHF_WEB'` y `TERMINAL_CONTABILIZACION` es el hostname real de
 * la PC que graba (`terminalActual()`, mismo patron que `usuarioActual()`).
 *
 * `FECHA_CONTABILIZACION` es la FECHA CONTABLE del comprobante, la misma
 * que va a `CPA04.FECHA_CONT` -- decision del usuario, 2026-09-07. No es la
 * de emision: si el comprobante se emitio dentro del periodo que Tango tiene
 * cerrado (`CPA10.CIERRE_CON`), el asiento fechado en emision caeria en un
 * mes cerrado. Tampoco es la de hoy. Ver `src/lib/fechaContable.ts`.
 * `ASIENTO_ANULACION`/`TRANSFERIDO_CN` quedan en `'N'`: no es una anulacion,
 * y la transferencia a Contabilidad ("pasar a contabilidad") sigue siendo
 * un proceso propio de Tango que corre el usuario dentro del ERP.
 *
 * Reutiliza `previsualizarAsientoEn` para calcular las lineas -- la vista
 * previa ("Ver asiento") y lo que se graba acá son literalmente el mismo
 * calculo, nunca pueden divergir.
 *
 * `IMPORTE_RENGLON_ALTER_CP` se graba igual a `IMPORTE_RENGLON_BASE_CP`
 * (sin ajuste). Verificado contra la base real: de 63.598 filas
 * existentes, solo 5 tienen ese valor igual al importe base -- en el resto
 * es el importe re-expresado por el modulo de Ajuste por Inflacion propio
 * de Tango (`INDICE`/`INDICE_VALOR`/`TMP_AJUSTE_INFLACION`), que esta app
 * no reproduce. Decision del usuario: que el proceso de ajuste de Tango lo
 * recalcule despues, igual que con cualquier asiento cargado por fuera de
 * ese modulo.
 *
 * No hace falta un chequeo de idempotencia propio: `registrarComprobanteEn`
 * ya vuelve temprano si el comprobante tiene `TANGO_NCOMP_IN_C`, asi que
 * esta funcion nunca corre dos veces para el mismo comprobante en el
 * camino normal. Si se llamara dos veces igual, `ASIENTO_COMPROBANTE_CP`
 * tiene un indice unico en `NCOMP_IN_C` -- la segunda vez falla con un
 * error de SQL claro en vez de duplicar un asiento en silencio, que para
 * un dato contable es el fallo mas seguro de los dos.
 */
export async function escribirAsientoEn(
  e: Ejecutor,
  comprobanteId: number,
  ncompInC: number,
  fechaContable: Date,
): Promise<void> {
  const asiento = await previsualizarAsientoEn(e, comprobanteId)
  if (!asiento.balanceado) {
    throw new Error(
      `El asiento no cierra (Debe $ ${asiento.totalDebe} vs Haber $ ${asiento.totalHaber}): no se puede contabilizar.`,
    )
  }
  if (asiento.lineas.length === 0) return

  const header = await e
    .request()
    .input('ncompInC', sql.Float, ncompInC)
    .input('usuario', sql.VarChar(120), 'PHF_WEB')
    .input('fechaContab', sql.DateTime, fechaContable)
    .input('terminal', sql.VarChar(255), terminalActual())
    .query<Record<string, unknown>>(`
      INSERT INTO ASIENTO_COMPROBANTE_CP
        (NCOMP_IN_C, ASIENTO_ANULACION, CONTABILIZADO, USUARIO_CONTABILIZACION,
         FECHA_CONTABILIZACION, TERMINAL_CONTABILIZACION, TRANSFERIDO_CN)
      OUTPUT INSERTED.ID_ASIENTO_COMPROBANTE_CP
      VALUES (@ncompInC, 'N', 'S', @usuario, @fechaContab, @terminal, 'N')
    `)
  const idAsientoComprobante = Number(header.recordset[0].ID_ASIENTO_COMPROBANTE_CP)

  let nroRenglon = 0
  for (const l of asiento.lineas) {
    nroRenglon += 1
    const importe = l.debe > 0 ? l.debe : l.haber
    await e
      .request()
      .input('idComp', sql.Int, idAsientoComprobante)
      .input('nro', sql.Int, nroRenglon)
      .input('idCuenta', sql.Int, l.idCuenta)
      .input('dh', sql.Char(1), l.debe > 0 ? 'D' : 'H')
      .input('importe', sql.Decimal(19, 4), importe)
      .input('leyenda', sql.VarChar(LARGO_LEYENDA), l.leyenda.slice(0, LARGO_LEYENDA))
      .input('edita', sql.Char(1), l.editaCuenta ? 'S' : 'N')
      .query(`
        INSERT INTO ASIENTO_CP
          (ID_ASIENTO_COMPROBANTE_CP, NRO_RENGLON_ASIENTO_CP, ID_CUENTA, D_H,
           IMPORTE_RENGLON_BASE_CP, IMPORTE_RENGLON_ALTER_CP, DESC_LEYENDA, EDITA_CUENTA)
        VALUES (@idComp, @nro, @idCuenta, @dh, @importe, @importe, @leyenda, @edita)
      `)
  }
}
