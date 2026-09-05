import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { obtenerDetalleEn, auditarEn } from '@/server/app/detalle'
import { nComp as armarNComp, letraComprobante, parsearFechaArg } from '@/lib/validaciones'
import { parsearImporte, totalImputado } from '@/lib/formato'
import { resolverAlicuotas, resolverCodigoIva } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { listarCondicionesCompra } from './condicionesCompra'
import { usuarioActual } from '@/lib/usuario'
import { listarAlicuotasIva, listarCodigosImpuesto } from './impuestos'
import { conceptoDelComprobante, COD_CONCEPTO_TARJETA } from './conceptos'
import { cargarAprendidosEn } from '@/server/app/aprendizajeImpuestos'
import { escribirAsientoEn } from './asiento'
import { escribirCuotasEn } from './cuotas'

export type ComprobanteCpa04 = {
  nComp: string
  codProvee: string
  total: number
  fechaEmision: Date
}

/** `CPA04.N_COMP` es `varchar(14)` -- verificado contra la base real. */
const LARGO_N_COMP = 14

/**
 * Solo T_COMP = 'FAC': es el unico tipo que esta app procesa (facturas de
 * compra). N_COMP codifica letra+puntoVenta(5)+numero(8) -- ver la nota de
 * verificacion en el plan de la Fase 3. `nComp` viene ya armado por
 * `src/lib/validaciones.ts::nComp`, esta funcion no reconstruye nada.
 */
export async function buscarFacturaEnCpa04(
  codProvee: string,
  nComp: string,
): Promise<ComprobanteCpa04 | null> {
  // `nComp` no trunca a proposito cuando el punto de venta o el numero
  // vienen mas largos de lo esperado: un dato pasado de largo tiene que
  // fallar el match y no esconderse. Pero pasarle ese valor al parametro
  // no fallaba el match: hacia explotar al driver antes de llegar a SQL
  // ("Parameter @nc: Data type 0xA7 has an invalid data length"), y con el
  // la pantalla de revision entera. Se corta aca: contra una columna de 14
  // caracteres, algo mas largo no puede coincidir con ninguna fila, asi que
  // "sin coincidencia" es la respuesta correcta y no una tapada. Al operador
  // el dato pasado de largo ya se lo marca validarFormatoNComp, que es donde
  // corresponde avisarle.
  if (nComp.length > LARGO_N_COMP) return null

  const pool = await getPool()
  const r = await pool
    .request()
    .input('cp', sql.VarChar(6), codProvee)
    .input('nc', sql.VarChar(LARGO_N_COMP), nComp)
    .query(`
      SELECT TOP 1 N_COMP, COD_PROVEE, IMPORTE_TO, FECHA_EMIS
      FROM CPA04
      WHERE T_COMP = 'FAC' AND COD_PROVEE = @cp AND N_COMP = @nc
    `)

  if (r.recordset.length === 0) return null
  const row = r.recordset[0]
  return {
    nComp: String(row.N_COMP).trim(),
    codProvee: String(row.COD_PROVEE).trim(),
    total: Number(row.IMPORTE_TO),
    fechaEmision: new Date(row.FECHA_EMIS),
  }
}

/**
 * Resuelve un porcentaje de alicuota extraido del comprobante al COD_IVA
 * real de CPA14. La logica vive en `src/lib/alicuotas.ts` porque el panel
 * de "listo para registrar" tiene que resolver exactamente igual: si los
 * dos criterios se separaran, el panel diria "listo" y el registro
 * fallaria igual.
 */
export async function mapearAlicuotaIva(
  porcentaje: number,
): Promise<{ codigo: number; porcentaje: number } | null> {
  const alicuotas = await listarAlicuotasIva()
  const resuelta = resolverCodigoIva(porcentaje, alicuotas)
  return resuelta ? { codigo: resuelta.codigo, porcentaje } : null
}

export type RegistroTango = { ncompInC: number; tComp: string; nComp: string }

// Sentinel que usa Tango para "sin fecha" en varias columnas de fecha legacy.
const SIN_FECHA = new Date('1800-01-01T03:53:48.000Z')

function horaActual(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
}

/**
 * Arma las hasta 5 alicuotas (codigo/porcentaje/importe) que van a los
 * slots de CPA04, resolviendo con la misma funcion que usa el panel de
 * "listo para registrar" -- ver el comentario de `resolverAlicuotas`.
 *
 * Se lee la lista de CPA14 una sola vez y se resuelven las cinco en
 * memoria, en vez de una consulta por slot.
 */
async function armarAlicuotas(
  valores: Record<string, string | null | undefined>,
  aprendidosIva: Record<string, string>,
): Promise<{ codigo: number; porcentaje: number; importe: number }[]> {
  const lineas = resolverAlicuotas(valores, await listarAlicuotasIva(), aprendidosIva)

  const sinCodigo = lineas.find((l) => l.estado === 'sin-codigo')
  if (sinCodigo) {
    throw new Error(
      `No se pudo resolver el código de IVA para la alícuota ${sinCodigo.slot} (${sinCodigo.porcentaje}%).`,
    )
  }

  // Las `omitida` (alicuota 0%) quedan afuera por norma de registracion.
  return lineas
    .filter((l) => l.estado === 'registra')
    .map((l) => ({ codigo: l.alicuota!.codigo, porcentaje: l.porcentaje, importe: l.importe }))
}

export async function registrarComprobanteEn(tx: sql.Transaction, id: number): Promise<RegistroTango> {
  await tx.request().query(`EXEC sp_getapplock @Resource='PHF_registro_tango', @LockMode='Exclusive'`)

  // 1. Idempotencia.
  const previo = await tx.request().input('id', sql.Int, id).query(`
    SELECT TANGO_NCOMP_IN_C, TANGO_T_COMP, TANGO_N_COMP FROM PHF_COMPROBANTE WHERE ID=@id`)
  if (previo.recordset[0]?.TANGO_NCOMP_IN_C != null) {
    return {
      ncompInC: Number(previo.recordset[0].TANGO_NCOMP_IN_C),
      tComp: String(previo.recordset[0].TANGO_T_COMP).trim(),
      nComp: String(previo.recordset[0].TANGO_N_COMP).trim(),
    }
  }

  const detalle = await obtenerDetalleEn(tx, id)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const codProvee = (valores.codprovee ?? '').trim()
  const proveedorRow = await tx.request().input('cod', sql.VarChar(6), codProvee).query(`
    SELECT LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razon, LTRIM(RTRIM(ISNULL(N_CUIT,''))) AS cuit,
           LTRIM(RTRIM(ISNULL(COND_IVA,''))) AS condIva
    FROM CPA01 WHERE COD_PROVEE=@cod`)
  if (proveedorRow.recordset.length === 0) {
    throw new Error(`El proveedor ${codProvee} ya no existe en Tango.`)
  }
  const proveedor = proveedorRow.recordset[0]

  // Lo que este proveedor ya le enseñó a la app para IVA e IIBB -- mismo
  // criterio y misma fuente que "listo para registrar", para que lo que
  // el panel dijo "ok" no pueda fallar acá por resolver distinto.
  //
  // Secuencial y no Promise.all: dos pedidos en vuelo sobre la misma
  // sql.Transaction cuelgan la conexión (mssql no los admite concurrentes)
  // en vez de fallar -- ver el mismo comentario en asiento.ts, donde se
  // reprodujo el cuelgue corriendo la suite de tests.
  const aprendidosIva = await cargarAprendidosEn(tx, codProvee, 'iva')
  const aprendidosPercep = await cargarAprendidosEn(tx, codProvee, 'percepcion')
  const aprendidosVarios = await cargarAprendidosEn(tx, codProvee, 'varios')

  const letra = letraComprobante(valores.tipo ?? '')
  if (!letra) throw new Error('No se pudo determinar la letra del comprobante.')
  const ptovta = (valores.ptovta ?? '').trim()
  const nro = (valores.nro ?? '').trim()
  const nComprobante = armarNComp(letra, ptovta, nro)
  // Dos codigos distintos, verificados contra la factura de referencia: T_COMP
  // ('FAC', varchar(3)) es el codigo de tipo visible; TCOMP_IN_C ('FP', varchar(2))
  // es el codigo interno de Tango ("Factura de Proveedor") que compone la clave
  // de NCOMP_IN_C. Usar 'FAC' para TCOMP_IN_C trunca -- el motivo real del bug
  // "String or binary data would be truncated" que encontro el test de integracion.
  const tComp = 'FAC'
  const tcompInC = 'FP'

  const codCondCompra = Number(valores.condcompra)
  const condiciones = await listarCondicionesCompra()
  const condicion = condiciones.find((c) => c.codigo === codCondCompra)
  if (!condicion) throw new Error(`La condición de compra ${codCondCompra} no existe en Tango.`)

  // Se resuelve y valida temprano, antes del INSERT de CPA04, para no
  // desperdiciarlo si el proveedor no tiene concepto configurado -- mismo
  // criterio que armarAlicuotas() mas abajo. El INSERT a CPA47 en si va
  // despues (seccion 6b): necesita ncompInC, que recien se conoce en el
  // paso "2. Numero interno".
  // En conceptos sale de la ficha del proveedor; en tarjeta es el fijo de
  // comisiones (406), porque lo que se imputa es la comision sin importar
  // que tarjeta o banco la cobre. Las de articulos no llevan concepto: se
  // imputan por renglon.
  const concepto = await conceptoDelComprobante(valores.tipoFactura, codProvee)
  if (!concepto && (valores.tipoFactura === 'conceptos' || valores.tipoFactura === 'tarjeta')) {
    throw new Error(
      valores.tipoFactura === 'tarjeta'
        ? `El concepto ${COD_CONCEPTO_TARJETA} de comisiones de tarjeta no existe en Tango.`
        : `El proveedor ${codProvee} no tiene un concepto configurado en Tango.`,
    )
  }

  // Bug real, encontrado registrando un comprobante real: esto hacia
  // `?? new Date()` -- una fecha que no parseaba (ver el comentario en
  // parsearFechaArg) grababa la factura en Tango con la fecha de HOY, en
  // silencio, sin ningun error. Ahora falla temprano en vez de adivinar.
  const fechaEmision = parsearFechaArg((valores.fecha ?? '').trim())
  if (!fechaEmision) {
    throw new Error(`No se pudo interpretar la fecha de emisión "${valores.fecha ?? ''}".`)
  }
  const neto = parsearImporte(valores.neto)
  const exento = parsearImporte(valores.exento)
  // En una liquidacion de tarjeta el total impreso en el resumen sale por
  // diferencia (arrastra saldo anterior, pagos, intereses que la app no
  // captura): no es el total del comprobante. Se graba subtotal + IVA +
  // impuestos -- decision del usuario, 2026-08-21 -- con la misma funcion
  // que ya usa "Total imputado" en el formulario y validarTotales, para que
  // lo que el operador ve en la revision sea siempre lo que se graba.
  const total =
    valores.tipoFactura === 'tarjeta' ? totalImputado(valores) : parsearImporte(valores.total)
  const cotizacion = parsearImporte(valores.cotizacion) || 1
  const moneda = (valores.moneda ?? 'ARS').trim().toUpperCase()

  const alicuotas = await armarAlicuotas(valores, aprendidosIva)
  while (alicuotas.length < 5) alicuotas.push({ codigo: 0, porcentaje: 0, importe: 0 })

  // 2. Numero interno.
  const maxR = await tx.request().query(`SELECT ISNULL(MAX(NCOMP_IN_C),0) AS mx FROM CPA04 WHERE TCOMP_IN_C='FP'`)
  const ncompInC = Number(maxR.recordset[0].mx) + 1

  const horaAhora = horaActual()
  const hoy = new Date()

  // 3. CPA04 + CTA05. Los literales fijos del VALUES (FILLER, CCONTROL, los
  // RG_3572_*/RG_3685_*, etc.) son columnas legacy de Tango copiadas tal
  // cual de la factura de referencia (NCOMP_IN_C=16591, proveedor 010246),
  // verificadas contra la base durante el diseño de esta fase -- no varian
  // entre comprobantes de tipo FAC en esta instalacion. Replican el patron
  // real, no una interpretacion de la documentacion de Tango.
  const cpa04Result = await tx.request()
    .input('tcompInC', sql.VarChar(2), tcompInC)
    .input('ncompInC', sql.Float, ncompInC)
    .input('nComp', sql.VarChar(20), nComprobante)
    .input('tipoCompr', sql.VarChar(1), letra)
    .input('codProvee', sql.VarChar(6), codProvee)
    .input('catIva', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('condCompr', sql.SmallInt, codCondCompra)
    .input('cotizacion', sql.Decimal(18, 4), cotizacion)
    .input('fechaEmis', sql.DateTime, fechaEmision)
    .input('importeNe', sql.Decimal(18, 2), neto)
    .input('importeEx', sql.Decimal(18, 2), exento)
    .input('importeTo', sql.Decimal(18, 2), total)
    // CPA04.LEYENDA es varchar(30), no 60 -- verificado contra la base real.
    // Descripciones de condicion de compra reales superan los 30 caracteres
    // (ej. "CTA CTE 30-60-90-120-150-180 DIAS", 34), asi que se trunca --
    // es solo la leyenda impresa, no un dato que otra tabla necesite entero.
    .input('leyenda', sql.VarChar(30), condicion.descripcion.slice(0, 30))
    .input('monCte', sql.Bit, moneda === 'ARS')
    .input('codIva1', sql.SmallInt, alicuotas[0].codigo).input('porcIva1', sql.Decimal(9, 4), alicuotas[0].porcentaje).input('impIva1', sql.Decimal(18, 2), alicuotas[0].importe)
    .input('codIva2', sql.SmallInt, alicuotas[1].codigo).input('porcIva2', sql.Decimal(9, 4), alicuotas[1].porcentaje).input('impIva2', sql.Decimal(18, 2), alicuotas[1].importe)
    .input('codIva3', sql.SmallInt, alicuotas[2].codigo).input('porcIva3', sql.Decimal(9, 4), alicuotas[2].porcentaje).input('impIva3', sql.Decimal(18, 2), alicuotas[2].importe)
    .input('codIva4', sql.SmallInt, alicuotas[3].codigo).input('porcIva4', sql.Decimal(9, 4), alicuotas[3].porcentaje).input('impIva4', sql.Decimal(18, 2), alicuotas[3].importe)
    .input('codIva5', sql.SmallInt, alicuotas[4].codigo).input('porcIva5', sql.Decimal(9, 4), alicuotas[4].porcentaje).input('impIva5', sql.Decimal(18, 2), alicuotas[4].importe)
    .input('horaIngreso', sql.VarChar(10), horaAhora)
    .input('hora', sql.VarChar(10), horaAhora)
    .input('usuarioIngreso', sql.VarChar(20), usuarioActual())
    .input('fechaIngreso', sql.DateTime, hoy)
    .input('sinFecha', sql.DateTime, SIN_FECHA)
    .query<Record<string, unknown>>(`
      DECLARE @idsCpa04 TABLE (ID_CPA04 INT);
      INSERT INTO CPA04 (
        TCOMP_IN_C, NCOMP_IN_C, T_COMP, N_COMP, TIPO_COMPR, COD_PROVEE, CAT_IVA,
        COND_COMPR, COTIZACION, FECHA_EMIS, FECHA_CONT, FECHA_VTO, IMPORTE_NE,
        SUBT_GRAVA, IMPORTE_EX, SUBT_EXENT, IMPORTE_TO, LEYENDA, MON_CTE,
        COD_IVA1, PORC_IVA1, IMP_IVA1, COD_IVA2, PORC_IVA2, IMP_IVA2,
        COD_IVA3, PORC_IVA3, IMP_IVA3, COD_IVA4, PORC_IVA4, IMP_IVA4,
        COD_IVA5, PORC_IVA5, IMP_IVA5, UNIDADES,
        HORA, HORA_INGRESO, USUARIO_INGRESO, TERMINAL_INGRESO, FECHA_INGRESO,
        FECHA_ULTIMA_MODIFICACION, HORA_ULTIMA_MODIFICACION, USUA_ULTIMA_MODIFICACION, TERM_ULTIMA_MODIFICACION,
        CAICAE_VTO, FECHA_ANULACION_OP, IMPUTACION_MODIFICADA, ID_LOTE_IMPORTACION_EXCEL,
        FILLER, BARRA_FON, CAI, CITI_OPERA, CITI_TIPO, COD_GASTO, COD_SECTOR, COMP_AFIP,
        CONTABILIZ, CONTFISCAL, DESPACHO, ESTADO, ESTADO_AUT, ESTADO_STK, IMPORTE_AN,
        IMPORTE_BO, IMPORTE_FL, IMPORTE_IN, INC_II, INC_IVA, LOTE, N_COMP_FON,
        PORC_BONIF, T_COMP_FON, TIPO_ASIEN, TIPO_IMPOR, DIFERENCIA, EXPORTADO, NRO_SUCURS,
        CCONTROL, BO_AUTORIZ, DOC_ELECTR, INF_IVA, CAICAE, MO_NO_CRED, T_DOC_DTE,
        N_INT_MES, IVA_CHILE, SUCURS_SII, CERRADO, COD_CLASIF, AFECTO_AF, EXENTO_AF,
        IVA_AF, ACTIVOFIJO, ID_ASIENTO_MODELO_CP, GENERA_ASIENTO, N_INT_ORI, T_INT_ORI,
        RG_3572_TIPO_OPERACION_HABITUAL_COMPRAS, RG_3572_CUIT_INTERMEDIARIO, COD_NO_RECUP,
        BO_TIPO_COMPRA, BO_ES_COMBUSTIBLE, RG_3572_DENOMINACION_INTERMEDIARIO,
        RG_3685_TIPO_OPERACION_COMPRAS, RG_3685_COMPROBANTE_COMPRAS, RG_3685_IVA_COMISION,
        IMPORTE_FLETE_RENGLON, SUBTOTAL_FLETE_RENGLON, ESTADO_UNIDADES, OBSERVACIONES,
        OBSERVACIONES_COMERCIALES, LEYENDA_1, LEYENDA_2, LEYENDA_3, LEYENDA_4, LEYENDA_5,
        TALONARIO, TIPO_TRANSACCION_VENTA, TIPO_TRANSACCION_COMPRA, MOTIVO_ANULACION_OP,
        HORA_ANULACION_OP, USUARIO_ANULACION_OP, TERMINAL_ANULACION_OP, NOTAS_OP,
        OP_NETO_GRAVADO_PAGO_CUENTA, OP_NETO_NO_GRAVADO_PAGO_CUENTA, OP_IMPORTE_TOTAL_PAGO_CUENTA,
        OP_IMPORTE_IVA_PAGO_CUENTA, OP_IMPORTE_SIN_IVA_PAGO_CUENTA, OP_IMPORTE_NO_CONSIDERA_PAGO_CUENTA,
        OP_TOTAL_PAGO_CUENTA, OP_IMPORTE_TOTAL_RETENCIONES, COD_CPA01,
        CONVERSOR_CLAUSULA_DIFERENCIA_ESTADOS, RETENCION_MODIFICADA, EXPORTADO_LID_CT, NRO_SUCURSAL_DESTINO
      )
      OUTPUT INSERTED.ID_CPA04 INTO @idsCpa04
      VALUES (
        @tcompInC, @ncompInC, 'FAC', @nComp, @tipoCompr, @codProvee, @catIva,
        @condCompr, @cotizacion, @fechaEmis, @fechaEmis, @sinFecha, @importeNe,
        @importeNe, @importeEx, @importeEx, @importeTo, @leyenda, @monCte,
        @codIva1, @porcIva1, @impIva1, @codIva2, @porcIva2, @impIva2,
        @codIva3, @porcIva3, @impIva3, @codIva4, @porcIva4, @impIva4,
        @codIva5, @porcIva5, @impIva5, @importeTo,
        @hora, @horaIngreso, @usuarioIngreso, 'PHF-WEB', @fechaIngreso,
        @sinFecha, '', '', '',
        @sinFecha, @sinFecha, NULL, NULL,
        '', 0, '', 'O', 'B', '', '', 0,
        0, 0, '', 'PEN', '', 'R', 0,
        0, 0, 0, 0, 0, 0, '',
        0, '', '', '', 'N', 0, 0,
        '', 0, 0, 'S', '', '', '',
        0, '', 0, 1, '', 0, 0,
        0, 'N', 1, 'S', 0, '',
        '', '', '',
        0, 0, '',
        '0', '001', 0,
        0, 0, 'PEN', '',
        '', '', '', '', '', '',
        50, 0, 0, '',
        '', '', '', '',
        0, 0, 0,
        0, 0, 0,
        0, 0, '',
        'N', 0, 0, 0
      );
      SELECT ID_CPA04 FROM @idsCpa04;`)
  const idCpa04 = Number(cpa04Result.recordset[0].ID_CPA04)

  await tx.request()
    .input('tcompInC', sql.VarChar(2), tcompInC)
    .input('ncompInC', sql.Float, ncompInC)
    .input('nComp', sql.VarChar(20), nComprobante)
    .input('codProvee', sql.VarChar(6), codProvee)
    .input('cuitPro', sql.VarChar(20), proveedor.cuit)
    .input('nombrePro', sql.VarChar(60), proveedor.razon)
    .input('condPro', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('catIva', sql.VarChar(10), proveedor.condIva || 'RI')
    .input('condCompr', sql.SmallInt, codCondCompra)
    .input('cotizacion', sql.Decimal(18, 4), cotizacion)
    .input('fechaEmis', sql.DateTime, fechaEmision)
    .input('importeNe', sql.Decimal(18, 2), neto)
    .input('importeEx', sql.Decimal(18, 2), exento)
    .input('importeTo', sql.Decimal(18, 2), total)
    .input('leyenda', sql.VarChar(30), condicion.descripcion.slice(0, 30))
    .input('monCte', sql.Bit, moneda === 'ARS')
    .input('impIva1', sql.Decimal(18, 2), alicuotas[0].importe).input('porcIva1', sql.Decimal(9, 4), alicuotas[0].porcentaje).input('codIva1', sql.SmallInt, alicuotas[0].codigo)
    .input('impIva2', sql.Decimal(18, 2), alicuotas[1].importe).input('porcIva2', sql.Decimal(9, 4), alicuotas[1].porcentaje).input('codIva2', sql.SmallInt, alicuotas[1].codigo)
    .input('impIva3', sql.Decimal(18, 2), alicuotas[2].importe).input('porcIva3', sql.Decimal(9, 4), alicuotas[2].porcentaje).input('codIva3', sql.SmallInt, alicuotas[2].codigo)
    .input('impIva4', sql.Decimal(18, 2), alicuotas[3].importe).input('porcIva4', sql.Decimal(9, 4), alicuotas[3].porcentaje).input('codIva4', sql.SmallInt, alicuotas[3].codigo)
    .input('impIva5', sql.Decimal(18, 2), alicuotas[4].importe).input('porcIva5', sql.Decimal(9, 4), alicuotas[4].porcentaje).input('codIva5', sql.SmallInt, alicuotas[4].codigo)
    .input('sinFecha', sql.DateTime, SIN_FECHA)
    .query(`
      INSERT INTO CTA05 (
        TCOMP_IN_C, NCOMP_IN_C, T_COMP, N_COMP, COD_PROVEE, CUIT_PRO, NOMBRE_PRO,
        COND_PRO, CAT_IVA, COND_COMPR, COTIZACION, FECHA_EMIS, FECHA_CONT, FECHA_VTO,
        IMP_NETO, SUBT_GRAVA, IMPORTE_EX, SUBT_EXENT, IMPORTE_TO, LEYENDA, MON_CTE,
        IMPOR_IVA1, PORC_IVA1, COD_IVA1, IMPOR_IVA2, PORC_IVA2, COD_IVA2,
        IMPOR_IVA3, PORC_IVA3, COD_IVA3, IMPOR_IVA4, PORC_IVA4, COD_IVA4,
        IMPOR_IVA5, PORC_IVA5, COD_IVA5, UNIDADES, NRO_SUCURS,
        FILLER, APLICA_PER, CAI, COD_GASTO, COMP_AFIP, CONTFISCAL, DESPACHO,
        ESTADO, ESTADO_AUT, FECHA_IMPO, HORA_IMPO, IMPORTE_AN, IMPORTE_BO,
        IMPORTE_FL, IMPORTE_IN, INC_II, INC_IVA, INGB_PRO, LOTE, T_FORM,
        TIPO_ASIEN, TIPO_IMPOR, CCONTROL, BO_AUTORIZ, DOC_ELECTR, INF_IVA,
        IVA_CHILE, T_DOC_DTE, SUCURS_SII, N_INT_MES, COD_CLASIF, AFECTO_AF,
        EXENTO_AF, IVA_AF, ACTIVOFIJO, ID_ASIENTO_MODELO_CP,
        RG_3572_TIPO_OPERACION_HABITUAL_COMPRAS, RG_3572_DENOMINACION_INTERMEDIARIO,
        RG_3685_IVA_COMISION, RG_3685_TIPO_OPERACION_COMPRAS, RG_3685_COMPROBANTE_COMPRAS,
        RG_3572_CUIT_INTERMEDIARIO, RG_3685_GENERA_INFORMACION_PROV_HABITUAL,
        RG_3685_GENERA_INFORMACION_PROV_OCASIONAL, COD_NO_RECUP, ESTADO_UNIDADES,
        TIPO_TRANSACCION_COMPRA, DOC_PRO
      ) VALUES (
        @tcompInC, @ncompInC, 'FAC', @nComp, @codProvee, @cuitPro, @nombrePro,
        @condPro, @catIva, @condCompr, @cotizacion, @fechaEmis, @fechaEmis, @sinFecha,
        @importeNe, @importeNe, @importeEx, @importeEx, @importeTo, @leyenda, @monCte,
        @impIva1, @porcIva1, @codIva1, @impIva2, @porcIva2, @codIva2,
        @impIva3, @porcIva3, @codIva3, @impIva4, @porcIva4, @codIva4,
        @impIva5, @porcIva5, @codIva5, @importeTo, 1001,
        '', 1, '', '', 0, 0, '',
        'PEN', '', @fechaEmis, '0000', 0, 0,
        0, 0, 0, 0, '', 0, '',
        '', '', '', 0, 0, 'S',
        '', '', 0, 0, '', 0,
        0, 0, 'N', 1,
        NULL, '',
        0, '0', '001',
        '', 1,
        NULL, '', 'PEN',
        0, 80
      )`)

  // 4. CPA18 + CTA06 (percepciones de IIBB e impuestos varios). Una fila
  // por slot con importe, resueltas con las mismas funciones que usa el
  // panel de la revision: si el panel dijo "listo", esto no puede fallar.
  const lineasPercep = resolverPercepciones(valores, valores.tipoFactura, aprendidosPercep)
  const percepSinCodigo = lineasPercep.find((l) => l.estado === 'sin-codigo')
  if (percepSinCodigo) {
    throw new Error(
      `No se reconoce la jurisdicción "${percepSinCodigo.texto}" de la percepción ${percepSinCodigo.slot}.`,
    )
  }

  const lineasVarios = resolverVarios(valores, await listarCodigosImpuesto(), aprendidosVarios)
  const variosSinCodigo = lineasVarios.find((l) => l.estado === 'sin-codigo')
  if (variosSinCodigo) {
    throw new Error(
      `El impuesto vario ${variosSinCodigo.slot} no tiene un código de Tango válido.`,
    )
  }

  const percepciones: { codigo: string; importe: number }[] = [
    ...lineasPercep.map((l) => ({ codigo: l.codigo!.codigo, importe: l.importe })),
    ...lineasVarios.map((l) => ({ codigo: l.codigo, importe: l.importe })),
  ]

  for (const p of percepciones) {
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('codImpues', sql.VarChar(10), p.codigo).input('codProvee', sql.VarChar(6), codProvee)
      .input('fComp', sql.DateTime, fechaEmision).input('importe', sql.Decimal(18, 2), p.importe)
      .query(`
        INSERT INTO CPA18 (TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES, COD_PROVEE, COD_PROV, F_COMP, IMPORTE, FILLER, COD_SII)
        VALUES (@tcompInC, @ncompInC, @codImpues, @codProvee, '', @fComp, @importe, '', '')`)

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('codImpues', sql.SmallInt, Number(p.codigo)).input('codProvee', sql.VarChar(6), codProvee)
      .input('fechaCont', sql.DateTime, fechaEmision).input('importe', sql.Decimal(18, 2), p.importe)
      .query(`
        INSERT INTO CTA06 (TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES, COD_PROVEE, FECHA_CONT, IMPORTE, NRO_SUCURS, FILLER, COD_SII)
        VALUES (@tcompInC, @ncompInC, @codImpues, @codProvee, @fechaCont, @importe, 1001, '', '')`)
  }

  // 5. CPA63 + clasificacion IVA (una fila por alicuota con importe, clasificacion SIN = sin categoria especial).
  for (const a of alicuotas.filter((x) => x.importe > 0)) {
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('importe', sql.Decimal(18, 2), a.importe).input('porcAlicu', sql.Decimal(9, 4), a.porcentaje)
      .query(`
        INSERT INTO CPA63 (TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU, FILLER)
        VALUES (@tcompInC, @ncompInC, 'SIN', @importe, @porcAlicu, '')`)

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('importe', sql.Decimal(18, 2), a.importe).input('porcAlicu', sql.Decimal(9, 4), a.porcentaje)
      .query(`
        INSERT INTO CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA (ID_SUCURSAL, TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU)
        VALUES (1, @tcompInC, @ncompInC, 'SIN', @importe, @porcAlicu)`)
  }

  // 6. CPA54 (vencimientos), uno por cuota de la condicion de compra --
  // ver cuotas.ts, mismo patron de preview+escritura que el asiento.
  await escribirCuotasEn(tx, id, codProvee, tComp, nComprobante, idCpa04)

  // 6b. CPA47 (renglon de concepto), en conceptos y en tarjeta. Un
  // solo renglon por comprobante -- confirmado contra la base real: 13.030
  // de 13.062 facturas de conceptos (99,75%) tienen exactamente un renglon
  // en CPA47. La ruta "por articulos" (bloque 7, mas abajo) sigue corriendo
  // igual sin condicionarla a esto -- ver spec, "Caso borde aceptado".
  if (concepto) {
    const importeNeRenglon = Math.round((neto + exento) * 100) / 100

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('codConcep', sql.VarChar(3), concepto.codConcepto).input('fechaMov', sql.DateTime, fechaEmision)
      .input('importeNe', sql.Decimal(18, 2), importeNeRenglon)
      .input('gravado', sql.Decimal(18, 2), neto).input('exentoRenglon', sql.Decimal(18, 2), exento)
      .query(`
        INSERT INTO CPA47 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_CONCEP, FECHA_MOV,
          IMPORTE_NE, IMPORT_PAN, IMP_NETO_P, IMPORTE_GRAVADO, IMPORTE_EXENTO,
          COD_CLASIF, FILLER
        ) VALUES (
          @tcompInC, @ncompInC, 1, @codConcep, @fechaMov,
          @importeNe, @importeNe, @importeNe, @gravado, @exentoRenglon,
          '', ''
        )`)
  }

  // 7. Renglones con remito asignado (solo si hay).
  const renglonesConRemito = detalle.renglones.filter((r) => r.remitoNcompInS && r.remitoNRenglS)
  const remitosAfectados = new Set<string>()

  for (const renglon of renglonesConRemito) {
    const remitoNcompInS = renglon.remitoNcompInS!
    const remitoNRenglS = renglon.remitoNRenglS!

    const staRow = await tx.request()
      .input('n', sql.VarChar(8), remitoNcompInS).input('r', sql.Int, remitoNRenglS)
      .query(`
        SELECT r.COD_ARTICU, r.COD_DEPOSI, r.CANTIDAD, r.CANT_FACTU, r.CANT_PEND, r.PRECIO_REM, h.NRO_SUCURS
        FROM STA20 r JOIN STA14 h ON h.TCOMP_IN_S=r.TCOMP_IN_S AND h.NCOMP_IN_S=r.NCOMP_IN_S
        WHERE r.TCOMP_IN_S='RP' AND r.NCOMP_IN_S=@n AND r.N_RENGL_S=@r`)
    if (staRow.recordset.length === 0) {
      throw new Error(`El renglón ${remitoNRenglS} del remito ${remitoNcompInS} ya no existe.`)
    }
    const sta = staRow.recordset[0]
    // CPA46 son los renglones del COMPROBANTE DE COMPRA -- la factura --, no
    // del remito. Lo unico que se toma de STA20 al armarlos es el articulo y
    // el deposito; la cantidad y el precio salen de la factura.
    //
    // La cantidad, en particular, nunca sale del remito: usar CANT_PEND o
    // CANTIDAD facturaria lo que el remito tiene pendiente y no lo que el
    // documento real dice, y romperia si el remito ya estaba parcialmente
    // facturado por otro comprobante (se re-facturaria lo ya facturado).
    const cantidad = parsearImporte(renglon.cantidad)
    if (cantidad <= 0) {
      throw new Error(`El renglón no tiene una cantidad válida para facturar contra el remito ${remitoNcompInS}.`)
    }
    // El articulo sale del remito, salvo que el operador lo haya corregido a
    // mano porque el emparejamiento automatico se equivoco. Sin esto, la
    // correccion se veria en pantalla y no llegaria a Tango, que es peor que
    // no ofrecerla: el operador creeria haberla arreglado.
    const codArticu = renglon.codigoFinal?.trim() || String(sta.COD_ARTICU).trim()
    const codDeposi = String(sta.COD_DEPOSI ?? '').trim()

    // El precio sale de la FACTURA, no del remito (decision del usuario,
    // 2026-08-20): el remito no es valorizado -- dice que entro y cuanto.
    // Se cae al del remito solo si la factura no lo trajo, y si no hay
    // ninguno de los dos se corta: grabar una compra a precio cero deja la
    // cuenta corriente del proveedor mal y no lo señala nada.
    const precioFactura = parsearImporte(renglon.precioUnitario)
    const precioLista = precioFactura > 0 ? precioFactura : Number(sta.PRECIO_REM)
    if (!(precioLista > 0)) {
      throw new Error(
        `El renglón del artículo ${codArticu} no tiene precio unitario: ` +
          `no figura en la factura ni en el remito ${remitoNcompInS}.`,
      )
    }

    // Tango guarda las tres cosas por separado, y asi las usa (verificado
    // contra 475 renglones reales de CPA46 con descuento):
    //
    //   PRECIO_PAN = precio de lista, antes del descuento
    //   PORCE_DCTO = el porcentaje
    //   PRECIO_NET = PRECIO_PAN x (1 - dcto/100)
    //   IMP_NETO_P = CANTIDAD x PRECIO_NET
    //
    // Antes se escribia el mismo precio en PRECIO_NET y PRECIO_PAN con
    // PORCE_DCTO en 0. En una factura real de TOPPER con 7% de
    // bonificacion eso inflaba el comprobante en $139.341,24 y la suma de
    // los renglones no cerraba contra el neto gravado de la cabecera.
    const bonificacion = parsearImporte(renglon.porcBonif)
    const precioNeto = Math.round(precioLista * (1 - bonificacion / 100) * 10000) / 10000
    const importeNetoRenglon = Math.round(cantidad * precioNeto * 100) / 100

    const nRenglC = renglonesConRemito.indexOf(renglon) + 1

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
      .input('codDeposi', sql.VarChar(10), codDeposi).input('cantidad', sql.Decimal(18, 4), cantidad)
      .input('precioNet', sql.Decimal(18, 4), precioNeto)
      .input('precioPan', sql.Decimal(18, 4), precioLista)
      .input('bonif', sql.Decimal(9, 4), bonificacion)
      .input('impNetoP', sql.Decimal(18, 2), importeNetoRenglon)
      .input('fechaMov', sql.DateTime, fechaEmision).input('idSta11', sql.Int, null)
      .query(`
        INSERT INTO CPA46 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
          PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, FALTA_REM,
          PORCE_DCTO, FILLER, COD_CLASIF, IMPORTE_EXENTO, IMPORTE_GRAVADO,
          CANTIDAD_2, FALTA_REM_2, UNIDAD_MEDIDA_SELECCIONADA, IMPORTE_FLETE,
          IMPORTE_IMPUESTOS_COSTOS, ID_STA11
        ) VALUES (
          @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
          @precioNet, @precioPan, @impNetoP, @fechaMov, 1, 0,
          @bonif, '', '', 0, @impNetoP,
          0, 0, 'P', 0,
          0, NULL
        )`)

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
      .input('codDeposi', sql.VarChar(10), codDeposi).input('cantidad', sql.Decimal(18, 4), cantidad)
      .input('precioNet', sql.Decimal(18, 4), precioNeto)
      .input('precioPan', sql.Decimal(18, 4), precioLista)
      .input('bonif', sql.Decimal(9, 4), bonificacion)
      .input('impNetoP', sql.Decimal(18, 2), importeNetoRenglon)
      .input('fechaMov', sql.DateTime, fechaEmision).input('nroSucurs', sql.SmallInt, Number(sta.NRO_SUCURS) || 1001)
      .query(`
        INSERT INTO CTA07 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
          PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, NRO_SUCURS,
          PORC_DTO, FILLER, COD_CLASIF, CANTIDAD_2, UNIDAD_MEDIDA_SELECCIONADA
        ) VALUES (
          @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
          @precioNet, @precioNet, @impNetoP, @fechaMov, 1, @nroSucurs,
          0, '', '', 0, 'P'
        )`)

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('nRenglS', sql.Int, remitoNRenglS)
      .input('ncompInS', sql.VarChar(8), remitoNcompInS).input('cantidad', sql.Decimal(18, 4), cantidad)
      .query(`
        INSERT INTO CPA48 (TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, N_RENGL_S, NCOMP_IN_S, TCOMP_IN_S, CANTIDAD, FILLER, CANTIDAD_2)
        VALUES (@tcompInC, @ncompInC, @nRenglC, @nRenglS, @ncompInS, 'RP', @cantidad, '', 0)`)

    const nuevoPend = Math.max(0, Number(sta.CANT_PEND) - cantidad)
    await tx.request()
      .input('n', sql.VarChar(8), remitoNcompInS).input('r', sql.Int, remitoNRenglS)
      .input('cantFactu', sql.Decimal(18, 4), Number(sta.CANT_FACTU) + cantidad)
      .input('cantPend', sql.Decimal(18, 4), nuevoPend)
      .query(`UPDATE STA20 SET CANT_FACTU=@cantFactu, CANT_PEND=@cantPend WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n AND N_RENGL_S=@r`)

    remitosAfectados.add(remitoNcompInS)
  }

  for (const ncompInS of remitosAfectados) {
    const pendiente = await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
      SELECT SUM(CANT_PEND) AS pend FROM STA20 WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
    if (Number(pendiente.recordset[0].pend) <= 0) {
      await tx.request().input('n', sql.VarChar(8), ncompInS).query(`
        UPDATE STA14 SET ESTADO_MOV='F' WHERE TCOMP_IN_S='RP' AND NCOMP_IN_S=@n`)
    }
  }

  // 8. Asiento contable: se arma en las tablas de staging que Tango lee
  // para "pasar a contabilidad" (ASIENTO_COMPROBANTE_CP/ASIENTO_CP), y
  // queda marcado CONTABILIZADO='S' con fecha de la factura -- decision
  // explicita del usuario, 2026-08-22. La transferencia a Contabilidad
  // ("pasar a contabilidad") sigue siendo un proceso propio de Tango que
  // corre el usuario desde el ERP. Va despues de todo lo demas para que
  // reuse, con obtenerDetalleEn, exactamente los mismos datos que ya
  // quedaron guardados -- ver escribirAsientoEn en asiento.ts.
  await escribirAsientoEn(tx, id, ncompInC, fechaEmision)

  // 9. Actualizar PHF_COMPROBANTE + auditoria.
  await tx.request()
    .input('id', sql.Int, id).input('ncompInC', sql.Float, ncompInC)
    .input('tComp', sql.VarChar(10), tComp).input('nComp', sql.VarChar(20), nComprobante)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO='registrado', TANGO_NCOMP_IN_C=@ncompInC, TANGO_T_COMP=@tComp, TANGO_N_COMP=@nComp,
          FECHA_REGISTRO=SYSDATETIME(), FECHA_MODIF=SYSDATETIME()
      WHERE ID=@id`)
  await auditarEn(tx, id, `Registrado en Tango: ${tComp} ${nComprobante} — asiento contabilizado, pendiente de transferir a Contabilidad`)

  return { ncompInC, tComp, nComp: nComprobante }
}

export async function registrarComprobante(id: number): Promise<RegistroTango> {
  return conTransaccion((tx) => registrarComprobanteEn(tx, id), sql.ISOLATION_LEVEL.SERIALIZABLE)
}
