import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion, fijarXactAbort } from '../db/tx'
import { obtenerDetalleEn, auditarEn } from '@/server/app/detalle'
import {
  nComp as armarNComp,
  letraComprobante,
  parsearFechaArg,
  LARGO_LEYENDA_COMPROBANTE,
  netoQueImplicaElIva,
} from '@/lib/validaciones'
import { parsearImporte, totalImputado } from '@/lib/formato'
import { importesSegunCondicionIva, clasificacionSiapDelExento } from '@/lib/condicionIva'
import { resolverAlicuotas, resolverCodigoIva } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { listarCondicionesCompra } from './condicionesCompra'
import { usuarioActual } from '@/lib/usuario'
import { listarAlicuotasIva, listarCodigosImpuesto } from './impuestos'
import { conceptoDelComprobante, COD_CONCEPTO_TARJETA } from './conceptos'
import { cargarAprendidosEn } from '@/server/app/aprendizajeImpuestos'
import { escribirAsientoEn } from './asiento'
import { escribirCuotasEn } from './cuotas'
import { fechaContableDe } from '@/lib/fechaContable'
import { resolverDescuentoDeDetalle, netosPorOrden, describirDescuento } from '@/lib/descuentoGlobal'
import { repartirNetoEntreHermanos } from '@/lib/talles'
import { cierreContable } from './parametros'
import { actualizarPrecioUltimaCompraEn } from './preciosCompra'
import {
  registrarRemitoEn,
  grabarRemitoEn,
  nCompRemito,
  describirRemitoGrabado,
  type RenglonARegistrar,
} from './remitosCompra'
import { seriesEfectivasEn } from '@/server/app/series'
import { planificarRemitosEn, consumirRemitosEn, contadoresAlFacturar } from './remitosFactura'
import { actualizarEstadoStkEn, marcarModificacionOcEn, TERMINAL_APP } from './estadoCircuito'
import { validarListoParaRegistrarEn, type ResultadoListoParaRegistrar } from '@/server/app/validaciones'

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

// La fecha "vacia" de Tango (1800-01-01) va como literal en el SQL,
// `CONVERT(datetime, '18000101', 112)`, y no como un Date de JavaScript:
// `new Date('1800-01-01T03:53:48Z')` daba 00:00 solo con el servidor en la
// zona de Buenos Aires (punto 14 de la revision contra Tango, 2026-11-17).

/**
 * Los mensajes de lo que bloquea en "Listo para registrar", para cortar el
 * registro con el mismo motivo que muestra la pantalla.
 */
export function erroresListoParaRegistrar(r: ResultadoListoParaRegistrar): string[] {
  const items = [
    r.condCompra, r.percepcionIibb, r.varios, r.formatoComp, r.fecha, r.tipoFactura,
    r.concepto, r.alicuotas, r.netoIva, r.ordenCompra, r.cantidadesOc, r.renglonesNeto,
    ...(r.stock ? [r.stock] : []),
    ...(r.remitos ? [r.remitos] : []),
  ]
  return items.filter((v) => v.estado === 'error').map((v) => v.mensaje)
}

/**
 * Lo que se imprime en `CPA04.LEYENDA`.
 *
 * Manda la observacion que el operador escribio en la revision -- la misma
 * que reemplaza la leyenda de cada renglon del asiento (pedido del usuario,
 * 2026-09-08). Es exactamente el tipo de texto que los propios usuarios de
 * Tango ponen ahi: de las leyendas ya cargadas en CPA04, las mas usadas
 * despues de las de plazo son "peajes", "combustibles viajes",
 * "COMBUSTIBLES COBRADORES", "GSTS DE COMB-TC ICBC".
 *
 * Si no hay observacion se cae a la descripcion de la condicion de compra,
 * que es lo que la app venia grabando y tambien tiene precedente en la base
 * ("PLAZO 60 DIAS", "PLAZO 30 DIAS"). Dejarla vacia tambien seria valido
 * --1.730 comprobantes de CPA04 la tienen asi-- pero perder un dato que ya
 * se estaba grabando no es parte de lo que se pidio.
 */
export function leyendaComprobante(
  observacion: string | null | undefined,
  descripcionCondicion: string,
): string {
  const texto = (observacion ?? '').trim() || descripcionCondicion
  return texto.slice(0, LARGO_LEYENDA_COMPROBANTE)
}

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
  //
  // Dos slots que resuelvan a la misma alicuota se suman en uno solo, no
  // ocupan dos: de los 27.090 comprobantes de CPA04 ni uno repite un COD_IVA
  // entre sus cinco slots, y dejarlos separados partiria en dos una alicuota
  // que Tango espera sumada. Es lo mismo que ya hace el asiento, que agrupa
  // por codigo (ver `genericas` en asiento.ts): asi los tres coinciden.
  return agruparPorCodigo(
    lineas
      .filter((l) => l.estado === 'registra')
      .map((l) => ({ codigo: l.alicuota!.codigo, porcentaje: l.porcentaje, importe: l.importe })),
  )
}

/**
 * Junta en una sola linea las que van al mismo codigo de Tango, sumando los
 * importes. Conserva el orden de aparicion y el porcentaje de la primera.
 */
function agruparPorCodigo<T extends { codigo: number | string; importe: number }>(lineas: T[]): T[] {
  const porCodigo = new Map<string, T>()
  for (const l of lineas) {
    const clave = String(l.codigo)
    const previa = porCodigo.get(clave)
    if (previa) {
      previa.importe = Math.round((previa.importe + l.importe) * 100) / 100
    } else {
      porCodigo.set(clave, { ...l })
    }
  }
  return [...porCodigo.values()]
}

export async function registrarComprobanteEn(tx: sql.Transaction, id: number): Promise<RegistroTango> {
  // XACT_ABORT ON: un error de SQL o un timeout aborta la transaccion entera
  // en el servidor, sin dejarla abierta con sus bloqueos hasta el rollback
  // (punto 6 de la revision contra Tango, 2026-11-17). El applock solo ordena
  // a las instancias de la app entre si; contra Tango ordena el semaforo de
  // PROXIMO_NUMERO, mas abajo. Con fijarXactAbort (`.batch()`): por
  // `.query()` el SET se revertiria al terminar el sp_executesql.
  await fijarXactAbort(tx, true)
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

  // Un remito de proveedor no pasa por Compras: es un movimiento de Stock,
  // con sus propias tablas. Ver remitosCompra.ts.
  if (valores.tipoFactura === 'remito') return registrarRemitoEn(tx, id)

  // El semaforo de numeracion de Tango (punto 5 de la revision contra
  // Tango, 2026-11-17). Antes del MAX + 1 de NCOMP_IN_C, Tango toma esta
  // fila con bloqueo de actualizacion y la retiene hasta el commit (la fila
  // vale 0 y no se actualiza: es solo un semaforo). Tomarlo aca, antes de
  // cualquier otra lectura con bloqueo, ordena a la app y a los usuarios de
  // Tango que graban comprobantes a la vez, y en el mismo orden que Tango
  // (primero esto, despues el proveedor, STA12, la OC), asi que no se pueden
  // trabar entre si. Se busca por tabla y campo, no por el ID (6 en esta
  // base), que puede variar entre bases.
  const semaforo = await tx.request().query(`
    SELECT ID_PROXIMO_NUMERO FROM PROXIMO_NUMERO WITH (UPDLOCK, ROWLOCK, HOLDLOCK)
    WHERE TABLA = 'CPA10' AND CAMPO = 'PROX_N_INT'`)
  if (semaforo.recordset.length !== 1) {
    throw new Error(
      `No se encontró el contador de comprobantes de Compras en Tango (PROXIMO_NUMERO CPA10/PROX_N_INT): ` +
        `hay ${semaforo.recordset.length} filas. No se registra.`,
    )
  }

  // Lo mismo que bloquea el boton en la pantalla, vuelto a correr aca,
  // dentro de la transaccion (punto 8 de la revision contra Tango): la
  // accion de servidor se puede llamar sin pasar por el boton, y no todas
  // esas validaciones se repiten mas abajo (el formato del numero, el cotejo
  // contra la OC, las series de la factura-remito).
  const errores = erroresListoParaRegistrar(await validarListoParaRegistrarEn(tx, id, detalle))
  if (errores.length > 0) {
    throw new Error(`El comprobante no está listo para registrar: ${errores.join(' ')}`)
  }

  const codProvee = (valores.codprovee ?? '').trim()
  // Con bloqueo: el saldo de esta fila se actualiza mas abajo (CPA01.SALDO_CC).
  const proveedorRow = await tx.request().input('cod', sql.VarChar(6), codProvee).query(`
    SELECT LTRIM(RTRIM(ISNULL(NOM_PROVEE,''))) AS razon, LTRIM(RTRIM(ISNULL(N_CUIT,''))) AS cuit,
           LTRIM(RTRIM(ISNULL(COND_IVA,''))) AS condIva
    FROM CPA01 WITH (UPDLOCK, ROWLOCK) WHERE COD_PROVEE=@cod`)
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

  // El duplicado, controlado dentro de la transaccion y con bloqueo (punto 7
  // de la revision contra Tango): la pantalla lo controla al importar y al
  // confirmar, pero entre eso y este momento alguien pudo cargarla desde
  // Tango. CPA04 no tiene indice unico por proveedor y numero (IX_0 es
  // COD_PROVEE, T_COMP, N_COMP, no unico): el HOLDLOCK sobre ese rango
  // impide que otro la inserte hasta el commit.
  const duplicada = await tx.request()
    .input('cp', sql.VarChar(6), codProvee)
    .input('nc', sql.VarChar(LARGO_N_COMP), nComprobante.slice(0, LARGO_N_COMP))
    .query(`
      SELECT TOP 1 ID_CPA04 FROM CPA04 WITH (UPDLOCK, HOLDLOCK)
      WHERE COD_PROVEE = @cp AND T_COMP = 'FAC' AND N_COMP = @nc`)
  if (duplicada.recordset.length > 0) {
    throw new Error(`La factura ${nComprobante} de este proveedor ya existe en Tango.`)
  }

  const codCondCompra = Number(valores.condcompra)
  const condiciones = await listarCondicionesCompra()
  const condicion = condiciones.find((c) => c.codigo === codCondCompra)
  if (!condicion) throw new Error(`La condición de compra ${codCondCompra} no existe en Tango.`)

  // La misma observacion que reemplaza la leyenda de los renglones del
  // asiento va tambien a CPA04.LEYENDA -- pedido del usuario, 2026-09-08.
  const leyenda = leyendaComprobante(valores.leyendaAsiento, condicion.descripcion)

  // Se resuelve y valida temprano, antes del INSERT de CPA04, para no
  // desperdiciarlo si el proveedor no tiene concepto configurado -- mismo
  // criterio que armarAlicuotas() mas abajo. El INSERT a CPA47 en si va
  // despues (seccion 6b): necesita ncompInC, que recien se conoce en el
  // paso "2. Numero interno".
  // En conceptos sale de la ficha del proveedor; en tarjeta es el fijo de
  // comisiones (406), porque lo que se imputa es la comision sin importar
  // que tarjeta o banco la cobre. Las de articulos no llevan concepto: se
  // imputan por renglon.
  const concepto = await conceptoDelComprobante(valores.tipoFactura, codProvee, valores.concepto)
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

  // La fecha con la que el comprobante entra a la contabilidad. Es la de
  // emision salvo que caiga dentro del periodo que Tango tiene cerrado
  // (CPA10.CIERRE_CON), y en ese caso va al primer dia del mes siguiente al
  // cierre -- regla del usuario, 2026-09-07, y es la que va a FECHA_CONT.
  //
  // Se recalcula aca en vez de confiar en lo que quedo guardado: entre que
  // el operador reviso y este momento, el cierre pudo haberse movido. Lo
  // guardado gana solo si el operador lo corrigio a mano, que es para lo que
  // el campo es editable -- mismo criterio de precedencia que el resto de la
  // app.
  const campoFechaContable = detalle.campos.find((c) => c.clave === 'fechacontable')
  const contableCorregida = campoFechaContable?.corregido
    ? parsearFechaArg((campoFechaContable.valorFinal ?? '').trim())
    : null
  const fechaContable = contableCorregida ?? fechaContableDe(fechaEmision, await cierreContable())
  const netoLeido = parsearImporte(valores.neto)
  const exentoLeido = parsearImporte(valores.exento)
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

  // CPA04 tiene cinco slots de IVA y ni uno mas. Hoy no se puede pasar --las
  // lineas salen de cinco pares porcivaN/impivaN y despues se agrupan por
  // codigo, asi que a lo sumo quedan cinco-- pero el INSERT de abajo lee
  // alicuotas[0..4] a mano: si alguna vez entraran seis, la sexta se
  // grabaria en ningun lado y su importe desapareceria sin que nada lo
  // señale. Cortar es la unica respuesta aceptable para un importe que no
  // tiene donde ir.
  if (alicuotas.length > 5) {
    const sobran = alicuotas.slice(5).map((a) => a.codigo).join(', ')
    throw new Error(
      `El comprobante tiene ${alicuotas.length} alícuotas de IVA distintas y Tango admite 5. ` +
        `No entran los códigos ${sobran}: unificá líneas antes de registrar.`,
    )
  }
  // Gravado y exento como los graba Tango segun la condicion de IVA del
  // proveedor (N3, 2026-11-18): un monotributista, un exento o un consumidor
  // final que factura sin IVA va todo exento. Ver condicionIva.ts.
  const { neto, exento, todoExento } = importesSegunCondicionIva(
    proveedor.condIva,
    netoLeido,
    exentoLeido,
    alicuotas.some((a) => a.importe > 0),
  )

  while (alicuotas.length < 5) alicuotas.push({ codigo: 0, porcentaje: 0, importe: 0 })

  // 2. Numero interno.
  //
  // NCOMP_IN_C es UNA serie compartida por facturas, notas de credito y
  // debito (TCOMP_IN_C FP/CP/DP/FS); solo las ordenes de pago (OP) numeran
  // aparte. Medido el 2026-09-15 sobre los 27.229 comprobantes de CPA04: 0
  // numeros repetidos entre FP/CP/DP/FS y 0 huecos en los ultimos 200, y
  // ASIENTO_COMPROBANTE_CP tiene un indice unico sobre NCOMP_IN_C a secas,
  // que solo puede existir si la serie es una.
  //
  // Hasta ese dia se tomaba el MAX de las FP nada mas, y fallo en produccion:
  // la app calculo 17533 (MAX de FP + 1) mientras una nota de credito cargada
  // desde Tango esa misma manana ya tenia ese numero. CPA04 lo acepto --su
  // indice unico es (TCOMP_IN_C, NCOMP_IN_C)-- y la escritura reviento
  // recien en ASIENTO_COMPROBANTE_CP con "duplicate key (17533)". Rollback
  // limpio, pero el comprobante no se pudo registrar.
  //
  // Se mira tambien ASIENTO_COMPROBANTE_CP porque es la tabla que impone la
  // unicidad: si alguna vez tuviera un numero que CPA04 no tiene, es ese el
  // que hay que saltar.
  //
  // Desde el 2026-11-17 el filtro es la lista de tipos de Tango
  // (`TCOMP_IN_C IN ('FS','FP','DP','CP')`, de la traza) y no `<> 'OP'`: asi
  // la app y Tango numeran igual aunque aparezca otro tipo. El MAX corre
  // despues del semaforo de PROXIMO_NUMERO, que lo serializa contra Tango.
  const maxR = await tx.request().query(`
    SELECT MAX(mx) AS mx FROM (
      SELECT ISNULL(MAX(NCOMP_IN_C), 0) AS mx FROM CPA04 WHERE TCOMP_IN_C IN ('FS', 'FP', 'DP', 'CP')
      UNION ALL
      SELECT ISNULL(MAX(NCOMP_IN_C), 0) FROM ASIENTO_COMPROBANTE_CP
    ) series
  `)
  const ncompInC = Number(maxR.recordset[0].mx) + 1

  const horaAhora = horaActual()
  // CPA04.FECHA_INGRESO va sin hora, como la manda Tango (punto 15): la hora
  // ya esta en HORA_INGRESO.
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)

  // Ninguna tabla CTA* (el espejo de Tango Central: CTA05/CTA06/CTA07,
  // CTA_COMPROBANTE_COMPRAS_CLASIFICACION_IVA) se escribe desde esta app --
  // decision del usuario, 2026-11-03. Tango las graba al registrar desde su
  // propia pantalla, pero ningun trigger lo hace, asi que un comprobante
  // registrado por la app queda sin esas filas. Si algun dia hacen falta,
  // las tiene que llenar Tango, no esta app.
  //
  // 3. CPA04. Los literales fijos del VALUES (FILLER, CCONTROL, los
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
    .input('fechaCont', sql.DateTime, fechaContable)
    .input('importeNe', sql.Decimal(18, 2), neto)
    .input('importeEx', sql.Decimal(18, 2), exento)
    .input('importeTo', sql.Decimal(18, 2), total)
    // La observacion del operador, o la condicion de compra si no escribio
    // ninguna -- ver `leyendaComprobante`. Se trunca a 30 porque la columna
    // es varchar(30), no 60: verificado contra la base real.
    .input('leyenda', sql.VarChar(LARGO_LEYENDA_COMPROBANTE), leyenda)
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
        @condCompr, @cotizacion, @fechaEmis, @fechaCont, CONVERT(datetime, '18000101', 112), @importeNe,
        @importeNe, @importeEx, @importeEx, @importeTo, @leyenda, @monCte,
        @codIva1, @porcIva1, @impIva1, @codIva2, @porcIva2, @impIva2,
        @codIva3, @porcIva3, @impIva3, @codIva4, @porcIva4, @impIva4,
        @codIva5, @porcIva5, @impIva5, @importeTo,
        @hora, @horaIngreso, @usuarioIngreso, 'PHF-WEB', @fechaIngreso,
        CONVERT(datetime, '18000101', 112), '', '', '',
        CONVERT(datetime, '18000101', 112), CONVERT(datetime, '18000101', 112), NULL, NULL,
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

  // 3b. El saldo del proveedor (punto 1 de la revision contra Tango,
  // 2026-11-17). Tango hace este UPDATE dentro de la transaccion de la
  // factura, despues del INSERT de CPA04, y ningun trigger lo hace: sin
  // esto la cuenta corriente del proveedor no veia la deuda. El saldo BAJA
  // con el total y las unidades bajan con lo mismo que va a CPA04.UNIDADES
  // (hoy el total: la cotizacion en unidades es el punto 13, fuera de esta
  // correccion).
  const saldo = await tx.request()
    .input('codProvee', sql.VarChar(6), codProvee)
    .input('importeTo', sql.Decimal(18, 2), total)
    .input('unidades', sql.Decimal(18, 2), total)
    .query<{ filas: number }>(`
      DECLARE @filas int;
      UPDATE CPA01 WITH (ROWLOCK)
         SET SALDO_CC          = ISNULL(SALDO_CC, 0) - @importeTo,
             SALDO_CC_UNIDADES = ISNULL(SALDO_CC_UNIDADES, 0) - @unidades
       WHERE COD_PROVEE = @codProvee;
      SET @filas = @@ROWCOUNT;
      SELECT @filas AS filas;`)
  if (saldo.recordset[0]?.filas !== 1) {
    throw new Error(`No se pudo actualizar el saldo del proveedor ${codProvee} en Tango.`)
  }

  // 4. CPA18 (percepciones de IIBB e impuestos varios). Una fila
  // por slot con importe, resueltas con las mismas funciones que usa el
  // panel de la revision: si el panel dijo "listo", esto no puede fallar.
  const codigosImpuesto = await listarCodigosImpuesto()
  const lineasPercep = resolverPercepciones(
    valores,
    valores.tipoFactura,
    aprendidosPercep,
    codigosImpuesto,
  )
  const percepSinCodigo = lineasPercep.find((l) => l.estado === 'sin-codigo')
  if (percepSinCodigo) {
    throw new Error(
      `No se reconoce la jurisdicción "${percepSinCodigo.texto}" de la percepción ${percepSinCodigo.slot}.`,
    )
  }

  const lineasVarios = resolverVarios(valores, codigosImpuesto, aprendidosVarios)
  const variosSinCodigo = lineasVarios.find((l) => l.estado === 'sin-codigo')
  if (variosSinCodigo) {
    throw new Error(
      `El impuesto vario ${variosSinCodigo.slot} no tiene un código de Tango válido.`,
    )
  }

  // CPA18 tiene un indice unico IX_0 sobre (COD_PROVEE, TCOMP_IN_C,
  // NCOMP_IN_C, COD_IMPUES): una sola fila por impuesto y comprobante. Dos
  // lineas que resuelvan al mismo codigo van sumadas en una, no bloquean --
  // decision del usuario, 2026-09-08. Un impuesto que el comprobante imprime
  // en dos renglones y Tango identifica con un solo codigo es, para Tango,
  // un solo importe.
  //
  // Las percepciones de IIBB y los impuestos varios se agrupan JUNTOS porque
  // escriben en la misma tabla y el indice unico no distingue de cual
  // familia venia la linea. Es lo mismo que ya hacia el asiento, que agrupa
  // por codigo (ver `genericas` en asiento.ts).
  const percepciones = agruparPorCodigo([
    ...lineasPercep.map((l) => ({ codigo: l.codigo!.codigo, importe: l.importe })),
    ...lineasVarios.map((l) => ({ codigo: l.codigo, importe: l.importe })),
  ])

  for (const p of percepciones) {
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('codImpues', sql.VarChar(10), p.codigo).input('codProvee', sql.VarChar(6), codProvee)
      .input('fComp', sql.DateTime, fechaEmision).input('importe', sql.Decimal(18, 2), p.importe)
      .query(`
        INSERT INTO CPA18 (TCOMP_IN_C, NCOMP_IN_C, COD_IMPUES, COD_PROVEE, COD_PROV, F_COMP, IMPORTE, FILLER, COD_SII)
        VALUES (@tcompInC, @ncompInC, @codImpues, @codProvee, '', @fComp, @importe, '', '')`)

  }

  // 5. CPA63 (una fila por alicuota con importe, clasificacion SIN = sin categoria especial).
  for (const a of alicuotas.filter((x) => x.importe > 0)) {
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('importe', sql.Decimal(18, 2), a.importe).input('porcAlicu', sql.Decimal(9, 4), a.porcentaje)
      .query(`
        INSERT INTO CPA63 (TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU, FILLER)
        VALUES (@tcompInC, @ncompInC, 'SIN', @importe, @porcAlicu, '')`)

  }

  // 5b. CPA63, la fila del exento (N3 y N4, 2026-11-18): al 0% por el
  // importe exento, con la clasificacion de la condicion de IVA del
  // proveedor (C9 monotributista, C7 exento o consumidor final, SIN el
  // resto). Tango la graba en toda factura con exento, tenga o no IVA; sin
  // ella el Libro IVA Digital no informa el exento. Ver condicionIva.ts.
  if (exento > 0) {
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('clasSiap', sql.VarChar(3), clasificacionSiapDelExento(proveedor.condIva))
      .input('importe', sql.Decimal(18, 2), exento)
      .query(`
        INSERT INTO CPA63 (TCOMP_IN_C, NCOMP_IN_C, CLAS_SIAP, IMPORTE, PORC_ALICU, FILLER)
        VALUES (@tcompInC, @ncompInC, @clasSiap, @importe, 0, '')`)
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

  // 7. Renglones imputados a una orden de compra (solo si hay).
  //
  // Desde 2026-09-06 las facturas de articulos se imputan a una OC y no se
  // cotejan contra un remito -- decision del usuario. La estructura es la
  // misma que tenia el circuito de remito, con dos cambios de destino:
  // el vinculo va a CPA_OC_FACTURA en vez de CPA48, y los contadores que se
  // descuentan son los de CPA36 en vez de los de STA20.
  const renglonesConOc = detalle.renglones.filter((r) => r.ocNOrdenCo && r.ocNRenglOc)
  // Las OC tocadas, por talonario + numero: al final se les actualiza la
  // auditoria de modificacion (CPA35).
  const ocsAfectadas = new Map<string, { nOrdenCo: string; talonario: number }>()
  // La factura-remito (2026-11-17, pedido del usuario): despues de la
  // factura se graba el remito con el mismo numero, recibiendo estos mismos
  // renglones. Por eso no consume remitos previos: la mercaderia de esta
  // factura entra con su propio remito.
  const esFacturaRemito = valores.tipoFactura === 'facturaRemito'
  const paraRemito: RenglonARegistrar[] = []
  // Lo que esta factura consumio de remitos, para dejarlo en el historial.
  const remitosConsumidos: string[] = []
  // El deposito al que entra la mercaderia de ESTA factura. Lo usan tambien
  // los cargos, mas abajo: van al mismo que los articulos del comprobante
  // (decision del usuario, 2026-09-22).
  let codDeposiFactura = ''

  // Lo que cobra la factura por renglon, resuelto una vez para todos: ver el
  // comentario del precio, mas abajo. Si no cierra contra el neto gravado se
  // corta aca, antes de tocar CPA46: es la misma condicion que bloquea el
  // panel de la revision.
  const descuento = resolverDescuentoDeDetalle(
    detalle.renglonesPdf,
    valores.descuentogeneral,
    valores.neto,
    // La base que implica el IVA impreso, que es la evidencia con la que se
    // decide si los subtotales son netos o brutos (ver descuentoGlobal.ts).
    netoQueImplicaElIva(resolverAlicuotas(valores, await listarAlicuotasIva(), aprendidosIva)),
  )
  if (renglonesConOc.length > 0 && !descuento.ok) {
    throw new Error(describirDescuento(descuento))
  }

  // Varios renglones pueden salir de la MISMA linea del PDF: es lo que pasa
  // con las facturas desglosadas por talle, donde una linea impresa son
  // cuatro articulos de Tango (2026-09-24, reportado por el usuario con
  // TOPPER). El subtotal impreso es uno solo para los cuatro, asi que se
  // reparte; sin esto cada talle se llevaba el importe entero de la linea.
  const netoDeCadaRenglon = repartirNetoEntreHermanos(
    renglonesConOc.map((r) => ({
      id: r.id,
      pdfOrden: r.pdfOrden,
      cantidad: parsearImporte(r.cantidad),
    })),
    netosPorOrden(descuento),
  )

  for (const renglon of renglonesConOc) {
    const nOrdenCo = renglon.ocNOrdenCo!
    const nRenglOc = renglon.ocNRenglOc!

    // Se relee la OC de Tango en vez de confiar en lo que quedo congelado al
    // elegirla: entre que el operador la imputo y este momento, otra factura
    // pudo haber consumido parte de lo pendiente.
    //
    // Con bloqueo de actualizacion (punto 6): la transaccion ya no es
    // SERIALIZABLE, y lo que se lee aca decide el tope y los contadores que
    // se graban despues. Y con el TALONARIO en el join y, si el renglon lo
    // guardo, en el filtro (punto 18): dos talonarios de OC pueden compartir
    // numero.
    const ocRow = await tx.request()
      .input('oc', sql.VarChar(14), nOrdenCo).input('r', sql.Int, nRenglOc)
      .input('tal', sql.SmallInt, renglon.ocTalonario)
      .query(`
        SELECT r.COD_ARTICU, r.COD_DEPOSI, r.PRECIO,
               ISNULL(r.CANTIDAD_FACTURADA, 0) AS CANTIDAD_FACTURADA,
               ISNULL(r.PENDIENTE_FACTURAR, 0) AS PENDIENTE_FACTURAR,
               ISNULL(r.PENDIENTE_RECIBIR_FACTURADA, 0) AS PENDIENTE_RECIBIR_FACTURADA,
               ISNULL(r.CAN_RECIBI, 0) AS CAN_RECIBI,
               h.NRO_SUCURS, h.TALONARIO
        FROM CPA36 r WITH (UPDLOCK, ROWLOCK)
        JOIN CPA35 h ON h.N_ORDEN_CO = r.N_ORDEN_CO AND h.TALONARIO = r.TALONARIO
        WHERE r.N_ORDEN_CO=@oc AND r.N_RENGL_OC=@r AND (@tal IS NULL OR r.TALONARIO = @tal)`)
    if (ocRow.recordset.length === 0) {
      throw new Error(`El renglón ${nRenglOc} de la orden de compra ${nOrdenCo.trim()} ya no existe.`)
    }
    if (ocRow.recordset.length > 1) {
      throw new Error(
        `La orden de compra ${nOrdenCo.trim()} existe en más de un talonario: volvé a elegir la orden del renglón.`,
      )
    }
    const sta = ocRow.recordset[0]

    const cantidad = parsearImporte(renglon.cantidad)
    if (cantidad <= 0) {
      throw new Error(
        `El renglón no tiene una cantidad válida para facturar contra la orden ${nOrdenCo.trim()}.`,
      )
    }
    // El tope se chequea contra lo que la OC tiene pendiente AHORA. La
    // pantalla ya lo valida al revisar (ver validarCotejoOc), pero eso fue
    // contra el pendiente congelado al imputar: este es el chequeo que no
    // se puede saltear, porque corre dentro de la misma transaccion que
    // descuenta.
    const pendiente = Number(sta.PENDIENTE_FACTURAR)
    if (cantidad - pendiente > 0.00005) {
      throw new Error(
        `El artículo ${String(sta.COD_ARTICU).trim()} factura ${cantidad} y la orden ` +
          `${nOrdenCo.trim()} tiene ${pendiente} pendiente(s) de facturar.`,
      )
    }

    // El articulo sale de la OC, salvo que el operador lo haya corregido a
    // mano. Sin esto, la correccion se veria en pantalla y no llegaria a
    // Tango, que es peor que no ofrecerla.
    const codArticu = renglon.codigoFinal?.trim() || String(sta.COD_ARTICU).trim()
    const codDeposi = String(sta.COD_DEPOSI ?? '').trim()
    if (!codDeposiFactura) codDeposiFactura = codDeposi

    // El precio es el que COBRA LA FACTURA, no el pactado en la OC --
    // decision del usuario, 2026-09-15: "los importes que valen son los de
    // la factura". Hay proveedores que imprimen el precio de lista y
    // descuentan al pie; el neto de cada renglon lo deriva
    // resolverDescuentoDeDetalle del subtotal impreso, y es la MISMA
    // resolucion que mostro la pantalla y valido el panel (ver
    // validarRenglonesContraNeto), asi que si la revision dijo que cierra,
    // esto graba exactamente esos importes.
    //
    // Hasta ese dia se grababa el precio de la OC con una bonificacion por
    // renglon: en una factura con descuento global el comprobante quedaba
    // inflado y la suma de los renglones no cerraba contra el neto.
    //
    // Se graba el neto directo, con PRECIO_PAN = PRECIO_NET y PORCE_DCTO en
    // 0 (decision del usuario): el descuento ya esta resuelto adentro del
    // precio, Tango no tiene que volver a aplicarlo.
    //
    // Un renglon sin resolucion --sin vinculo al PDF, o con el PDF sin precio
    // o subtotal-- corta: no se inventa un precio ni se cae al de la OC.
    // Decision del usuario: bloquear y reprocesar.
    const neto = netoDeCadaRenglon.get(renglon.id) ?? null
    if (!neto) {
      throw new Error(
        `El renglón del artículo ${codArticu} no tiene precio ni subtotal leídos de la factura: ` +
          `reprocesá el comprobante antes de registrarlo.`,
      )
    }
    const precioNeto = neto.precioNeto
    const precioLista = precioNeto
    const bonificacion = 0
    const importeNetoRenglon = neto.importeNeto

    const nRenglC = renglonesConOc.indexOf(renglon) + 1

    // Si la mercaderia de este renglon ya entro por remito, la factura lo
    // consume (2026-11-03). Se decide antes de grabar CPA46 porque lo que
    // ningun remito cubre va en FALTA_REM.
    const remitos = esFacturaRemito
      ? { partes: [], faltaRem: cantidad }
      : await planificarRemitosEn(tx, {
          codProvee,
          nOrdenCo,
          nRenglOc,
          codArticu,
          cantidad,
        })
    if (esFacturaRemito) {
      paraRemito.push({ renglonId: renglon.id, codArticu, cantidad, factura: { tcompInC, ncompInC, nRenglC } })
    }

    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
      .input('codDeposi', sql.VarChar(10), codDeposi).input('cantidad', sql.Decimal(18, 4), cantidad)
      .input('precioNet', sql.Decimal(18, 4), precioNeto)
      .input('precioPan', sql.Decimal(18, 4), precioLista)
      .input('bonif', sql.Decimal(9, 4), bonificacion)
      .input('impNetoP', sql.Decimal(18, 2), importeNetoRenglon)
      // Exento o gravado segun la condicion de IVA del proveedor (N3).
      .input('impExento', sql.Decimal(18, 2), todoExento ? importeNetoRenglon : 0)
      .input('impGravado', sql.Decimal(18, 2), todoExento ? 0 : importeNetoRenglon)
      .input('fechaMov', sql.DateTime, fechaEmision).input('idSta11', sql.Int, null)
      .input('faltaRem', sql.Decimal(18, 4), remitos.faltaRem)
      // ID_MEDIDA_STOCK es la unidad de stock del articulo (STA11), como la
      // manda Tango (punto 11). ID_MEDIDA_COMPRA e ID_MEDIDA_STOCK_2 quedan
      // NULL, igual que en Tango. ID_CPA04 e ID_STA11 los completa el trigger
      // de CPA46, que usa variables escalares: por eso el INSERT sigue siendo
      // de un renglon por vez (punto 19).
      .query(`
        INSERT INTO CPA46 (
          TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
          PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, FALTA_REM,
          PORCE_DCTO, FILLER, COD_CLASIF, IMPORTE_EXENTO, IMPORTE_GRAVADO,
          CANTIDAD_2, FALTA_REM_2, UNIDAD_MEDIDA_SELECCIONADA, IMPORTE_FLETE,
          IMPORTE_IMPUESTOS_COSTOS, ID_STA11, ID_MEDIDA_STOCK
        ) VALUES (
          @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
          @precioNet, @precioPan, @impNetoP, @fechaMov, 1, @faltaRem,
          @bonif, '', '', @impExento, @impGravado,
          0, 0, 'P', 0,
          0, NULL, (SELECT ID_MEDIDA_STOCK FROM STA11 WHERE COD_ARTICU = @codArticu)
        )`)

    // El vinculo entre el renglon de la factura y el de la orden de compra.
    // `TALONARIO_OC` sale de CPA35.TALONARIO -- verificado sobre las 9.975
    // filas reales de CPA_OC_FACTURA, coincide siempre.
    //
    // `ID_CPA_OC_FACTURA` es IDENTITY: no se especifica.
    await tx.request()
      .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
      .input('nRenglC', sql.Int, nRenglC).input('nRenglOc', sql.Int, nRenglOc)
      .input('oc', sql.VarChar(14), nOrdenCo)
      .input('talonario', sql.SmallInt, Number(sta.TALONARIO) || 0)
      .input('cantidad', sql.Decimal(18, 4), cantidad)
      .query(`
        INSERT INTO CPA_OC_FACTURA
          (TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, TALONARIO_OC, N_ORDEN_CO, N_RENGL_OC, CANTIDAD, CANTIDAD_2)
        VALUES (@tcompInC, @ncompInC, @nRenglC, @talonario, @oc, @nRenglOc, @cantidad, 0)`)

    // El consumo del remito: CPA48, CPA_OC_REMITO_FACTURA, el pendiente de
    // STA20 y el estado de STA14. Ver remitosFactura.ts.
    await consumirRemitosEn(tx, {
      tcompInC,
      ncompInC,
      nRenglC,
      partes: remitos.partes,
      oc: { talonario: Number(sta.TALONARIO) || 0, nOrdenCo, nRenglOc, cantidadImputada: cantidad },
    })
    for (const parte of remitos.partes) {
      remitosConsumidos.push(`${parte.cantidad} de ${codArticu} del remito interno ${parte.ncompInS.trim()}`)
    }

    // Los contadores de la OC. No hay ningun trigger que los mantenga --
    // verificado sobre CPA36 y CPA_OC_FACTURA --: los lleva el cliente de
    // Tango, asi que si esta app no los actualiza la orden quedaria
    // mostrando todo como pendiente para siempre. Decision del usuario,
    // 2026-09-06.
    //
    // CANTIDAD_FACTURADA_PANTALLA es lo que la pantalla de ordenes de Tango
    // muestra como facturado, y acompaña a CANTIDAD_FACTURADA: en las 6.290
    // filas de CPA36 con algo facturado las dos son iguales, sin una sola
    // excepcion, incluidas las que se facturaron en siete u ocho veces. Por
    // eso acumula igual que ella y no guarda la cantidad de esta factura
    // sola. Sin esto, una orden facturada por esta app le figuraba en cero
    // al usuario dentro de Tango -- que es como aparecio (2026-09-07).
    //
    // PENDIENTE_FACTURAR_RECIBIDA y PENDIENTE_RECIBIR_FACTURADA son la
    // diferencia entre lo recibido y lo facturado, sin bajar de 0: lo que
    // entro por remito y falta facturar, y lo facturado que falta recibir.
    // Es la regla que cumplen 6.397 y 6.400 de las 6.431 filas reales con
    // algo recibido y facturado (ver contadoresAlFacturar).
    //
    // Hasta 2026-11-03 esta app grababa PENDIENTE_RECIBIR_FACTURADA con la
    // cantidad facturada -- indicacion del usuario, 2026-09-07 --, lo que
    // dejaba dicho que faltaba recibir algo que ya habia entrado cuando la
    // orden tenia un remito. El usuario aprobo pasar a la regla de Tango el
    // 2026-11-03; sin remito recibido da lo mismo que antes.
    //
    // Las variantes _2 siguen sin tocarse: esta app no las usa.
    const contadores = contadoresAlFacturar(
      { recibida: Number(sta.CAN_RECIBI), facturada: Number(sta.CANTIDAD_FACTURADA) },
      cantidad,
    )
    await tx.request()
      .input('oc', sql.VarChar(14), nOrdenCo).input('r', sql.Int, nRenglOc)
      .input('facturada', sql.Decimal(18, 4), contadores.facturada)
      .input('pend', sql.Decimal(18, 4), Math.max(0, pendiente - cantidad))
      .input('pfr', sql.Decimal(18, 4), contadores.pendienteFacturarRecibida)
      .input('prf', sql.Decimal(18, 4), contadores.pendienteRecibirFacturada)
      .input('talonario', sql.SmallInt, Number(sta.TALONARIO) || 0)
      .query(`
        UPDATE CPA36
        SET CANTIDAD_FACTURADA = @facturada,
            CANTIDAD_FACTURADA_PANTALLA = @facturada,
            PENDIENTE_FACTURAR = @pend,
            PENDIENTE_FACTURAR_RECIBIDA = @pfr,
            PENDIENTE_RECIBIR_FACTURADA = @prf
        WHERE N_ORDEN_CO=@oc AND N_RENGL_OC=@r AND TALONARIO=@talonario`)

    // El precio de ultima compra del articulo (STA12): lo que Tango
    // actualiza al registrar una factura, y que esta app no hacia --
    // pedido del usuario, 2026-09-21. Con la fecha de emision y la fila de
    // auditoria de costo del renglon (puntos 9 y 10, 2026-11-17). Ver
    // preciosCompra.ts.
    await actualizarPrecioUltimaCompraEn(tx, {
      codArticu,
      precioNeto,
      codProvee,
      fecha: fechaEmision,
      cotizacion,
      monCte: moneda === 'ARS',
      auditoria: {
        tComp, nComp: nComprobante, tcompInC, ncompInC, nRenglC,
        usuario: usuarioActual(), hora: horaAhora, terminal: TERMINAL_APP,
      },
    })

    const talonarioOc = Number(sta.TALONARIO) || 0
    ocsAfectadas.set(`${talonarioOc}|${nOrdenCo}`, { nOrdenCo, talonario: talonarioOc })
  }

  // La OC NO pasa a Cumplida al facturarla (punto 2 de la revision contra
  // Tango, 2026-11-17): Tango dejo en 3 (Emitida) una OC toda facturada y
  // sin nada recibido, y la paso a 10 recien con el remito que recibio todo.
  // La OC sigue esperando la mercaderia. Hasta ese dia la app la pasaba a 10
  // cuando no le quedaba nada por facturar. Lo que si cambia Tango al
  // facturar es la auditoria de modificacion de la cabecera, una vez por OC.
  for (const oc of ocsAfectadas.values()) {
    await marcarModificacionOcEn(tx, oc)
  }

  if (remitosConsumidos.length > 0) {
    await auditarEn(tx, id, `Facturó contra remito: ${remitosConsumidos.join('; ')}`)
  }

  // 7b. Los CARGOS del proveedor: renglones que la factura cobra y que no
  // van contra ninguna orden de compra -- 2026-09-22, pedido del usuario.
  // RED DEL INTERIOR factura "GESTION DE COMPRA 1%" y "GESTION ROSARIO
  // LOGISTICA S.A.": el operador las vincula a un articulo de Tango, la app
  // lo recuerda (SIN_OC en PHF_ARTICULO_PROVEEDOR) y se registran igual.
  //
  // Van a CPA46 como cualquier renglon --por eso entran en la factura
  // y en el asiento, que agrupa los renglones por su cuenta de compras--
  // pero NO generan vinculo en CPA_OC_FACTURA ni descuentan CPA36: no hay
  // orden que consumir.
  //
  // El deposito es el MISMO que el de los articulos de esta factura
  // (decision del usuario, 2026-09-22): un cargo no tiene orden de donde
  // sacarlo, pero entra al mismo deposito que la mercaderia que acompaña.
  // Una factura de SOLO cargos no tiene renglon de OC del cual tomarlo: ahi
  // se cae al mas usado en las ordenes --medido sobre CPA36, el "01"
  // concentra 7.680 de 7.711 renglones--, porque CPA46.COD_DEPOSI es parte
  // de la clave con la que Stock ubica el renglon y no puede quedar vacio.
  //
  // FALTA_REM (2026-11-18, punto 4 de la revision contra Tango): si el
  // articulo lleva stock (STA11.STOCK) es mercaderia sin OC y queda toda
  // pendiente de remitir, como la graba Tango en la factura sin OC (00259 y
  // 100005, FALTA_REM = cantidad). Hasta ese dia iba en 0: la factura quedaba
  // 'R' y no aparecia como pendiente de remito. Los cargos de verdad
  // (gestion de compra, fletes) estan vinculados a articulos sin stock --al
  // 2026-11-18 todos los SIN_OC de PHF_ARTICULO_PROVEEDOR van al 107056
  // "GASTOS AD. FACTURADOS"-- y siguen en 0: no hay mercaderia que recibir.
  const renglonesCargo = detalle.renglones.filter((r) => !r.ocNOrdenCo && !r.ocNRenglOc)
  if (renglonesCargo.length > 0) {
    if (!descuento.ok) throw new Error(describirDescuento(descuento))

    let codDeposiCargo = codDeposiFactura
    if (!codDeposiCargo) {
      const depoR = await tx.request().query<{ cod: string | null }>(`
        SELECT TOP 1 LTRIM(RTRIM(COD_DEPOSI)) AS cod
        FROM CPA36 WHERE LTRIM(RTRIM(ISNULL(COD_DEPOSI, ''))) <> ''
        GROUP BY LTRIM(RTRIM(COD_DEPOSI)) ORDER BY COUNT(*) DESC`)
      codDeposiCargo = String(depoR.recordset[0]?.cod ?? '').trim()
    }

    let nRenglC = renglonesConOc.length
    for (const renglon of renglonesCargo) {
      const codArticu = (renglon.codigoFinal ?? renglon.codigo ?? '').trim()
      if (!codArticu) {
        throw new Error(
          `Un renglón sin orden de compra no tiene artículo: vinculalo antes de registrar.`,
        )
      }
      const cantidad = parsearImporte(renglon.cantidad)
      const neto =
        renglon.pdfOrden === null ? null : (netosPorOrden(descuento).get(renglon.pdfOrden) ?? null)
      if (!neto) {
        throw new Error(
          `El renglón del artículo ${codArticu} no tiene precio ni subtotal leídos de la factura: ` +
            `reprocesá el comprobante antes de registrarlo.`,
        )
      }
      nRenglC += 1

      const art = await tx.request().input('art', sql.VarChar(15), codArticu)
        .query<{ STOCK: boolean | null }>('SELECT STOCK FROM STA11 WHERE COD_ARTICU = @art')
      const llevaStock = Boolean(art.recordset[0]?.STOCK)
      const faltaRem = llevaStock ? cantidad : 0
      // En la factura-remito, la mercaderia sin OC entra con el mismo remito
      // que la de la orden: si no, la factura quedaria pendiente de remitir.
      if (esFacturaRemito && llevaStock) {
        paraRemito.push({ renglonId: renglon.id, codArticu, cantidad, factura: { tcompInC, ncompInC, nRenglC } })
      }

      await tx.request()
        .input('tcompInC', sql.VarChar(2), tcompInC).input('ncompInC', sql.Float, ncompInC)
        .input('nRenglC', sql.Int, nRenglC).input('codArticu', sql.VarChar(20), codArticu)
        .input('codDeposi', sql.VarChar(10), codDeposiCargo)
        .input('cantidad', sql.Decimal(18, 4), cantidad)
        .input('faltaRem', sql.Decimal(18, 4), faltaRem)
        .input('precioNet', sql.Decimal(18, 4), neto.precioNeto)
        .input('impNetoP', sql.Decimal(18, 2), neto.importeNeto)
        .input('impExento', sql.Decimal(18, 2), todoExento ? neto.importeNeto : 0)
        .input('impGravado', sql.Decimal(18, 2), todoExento ? 0 : neto.importeNeto)
        .input('fechaMov', sql.DateTime, fechaEmision)
        .query(`
          INSERT INTO CPA46 (
            TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C, COD_ARTICU, COD_DEPOSI, CANTIDAD,
            PRECIO_NET, PRECIO_PAN, IMP_NETO_P, FECHA_MOV, EQUIVALENC, FALTA_REM,
            PORCE_DCTO, FILLER, COD_CLASIF, IMPORTE_EXENTO, IMPORTE_GRAVADO,
            CANTIDAD_2, FALTA_REM_2, UNIDAD_MEDIDA_SELECCIONADA, IMPORTE_FLETE,
            IMPORTE_IMPUESTOS_COSTOS, ID_STA11
          ) VALUES (
            @tcompInC, @ncompInC, @nRenglC, @codArticu, @codDeposi, @cantidad,
            @precioNet, @precioNet, @impNetoP, @fechaMov, 1, @faltaRem,
            0, '', '', @impExento, @impGravado,
            0, 0, 'P', 0,
            0, NULL
          )`)

      // Un cargo tambien mueve el precio de ultima compra del articulo al
      // que se lo imputa: para Tango es una compra mas de ese articulo.
      await actualizarPrecioUltimaCompraEn(tx, {
        codArticu,
        precioNeto: neto.precioNeto,
        codProvee,
        fecha: fechaEmision,
        cotizacion,
        monCte: moneda === 'ARS',
        auditoria: {
          tComp, nComp: nComprobante, tcompInC, ncompInC, nRenglC,
          usuario: usuarioActual(), hora: horaAhora, terminal: TERMINAL_APP,
        },
      })
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
  // Con la fecha CONTABLE, no la de emision: el asiento tiene que caer en el
  // mismo periodo que la factura en CPA04, y si el comprobante se emitio
  // dentro de lo que Tango tiene cerrado ese periodo no es el de emision.
  //
  // FECHA_CONTABILIZACION es el momento del registro, sin milisegundos, como
  // la manda Tango (punto 15, 2026-11-17). El periodo del asiento lo da
  // CPA04.FECHA_CONT, que sigue siendo la fecha contable.
  const ahora = new Date()
  ahora.setMilliseconds(0)
  await escribirAsientoEn(tx, id, ncompInC, ahora)

  // CPA04.ESTADO_STK: 'P' si algun renglon quedo con algo sin remitir, 'R'
  // si no (punto 3 de la revision contra Tango). Va despues de todos los
  // renglones (los de OC, con lo que consumieron de remitos previos, y los
  // cargos). La factura-remito lo vuelve a calcular cuando su remito la
  // recibe, mas abajo.
  await actualizarEstadoStkEn(tx, tcompInC, ncompInC)

  // 8b. La factura-remito: el remito, con el mismo punto de venta y numero
  // ("R" en vez de la letra), recibiendo los renglones que la factura
  // acaba de imputar a la OC. Es el mismo registro que el de un remito
  // suelto contra una factura (remitosCompra.ts): STA14/STA20, STA19, CPA48,
  // FALTA_REM en 0, la OC heredada (CPA_OC_REMITO, CPA_OC_REMITO_FACTURA,
  // CPA36) y las series. Los articulos que no llevan stock (un servicio
  // imputado a la orden) quedan solo en la factura. De los renglones sin OC
  // entran los de articulos con stock (mercaderia, 2026-11-18), sin OC
  // heredada; los cargos sin stock no.
  let remitoGrabado: string | null = null
  if (esFacturaRemito) {
    const conStock: RenglonARegistrar[] = []
    for (const r of paraRemito) {
      const a = await tx.request().input('art', sql.VarChar(15), r.codArticu)
        .query('SELECT STOCK FROM STA11 WHERE COD_ARTICU = @art')
      if (a.recordset[0]?.STOCK) conStock.push(r)
    }
    if (conStock.length > 0) {
      const nCompR = nCompRemito(ptovta, nro)
      if (nCompR.length !== 14) {
        throw new Error(`El número ${ptovta}-${nro} no entra en el formato de remito de Tango.`)
      }
      const g = await grabarRemitoEn(tx, {
        codProvee,
        nComp: nCompR,
        fecha: fechaEmision,
        observacion: (valores.leyendaAsiento ?? '').trim().slice(0, 30),
        renglones: conStock,
        series: await seriesEfectivasEn(tx, id, detalle.renglones),
      })
      remitoGrabado = describirRemitoGrabado(nCompR, g, conStock)
    }
  }

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
  if (remitoGrabado) await auditarEn(tx, id, `Registrado en Tango con la factura: ${remitoGrabado}`)
  else if (esFacturaRemito) {
    await auditarEn(tx, id, 'Factura-remito sin artículos que lleven stock: no se grabó remito')
  }

  return { ncompInC, tComp, nComp: nComprobante }
}

/**
 * READ COMMITTED, como Tango, desde el 2026-11-17 (punto 6 de la revision
 * contra Tango). Hasta ese dia corria en SERIALIZABLE: cada lectura tomaba
 * bloqueos de rango (CPA04, CPA36, STA20, STA12...) hasta el commit y podia
 * frenar a los usuarios de Tango mientras duraba el registro. Ahora cada
 * lectura que decide algo lleva su bloqueo explicito:
 *
 * - `PROXIMO_NUMERO` (semaforo de la numeracion), `UPDLOCK, ROWLOCK, HOLDLOCK`;
 * - `CPA04` (control de duplicado), `UPDLOCK, HOLDLOCK`;
 * - `CPA01` (proveedor, cuyo saldo se actualiza), `UPDLOCK, ROWLOCK`;
 * - `CPA36` (renglon de la OC), `UPDLOCK, ROWLOCK`;
 * - `STA12` (precio anterior para la auditoria), `UPDLOCK, ROWLOCK, HOLDLOCK`,
 *   y el `MERGE STA12 WITH (HOLDLOCK)` como estaba;
 * - remito (`grabarRemitoEn`): `CPA56` y el duplicado de `STA14` con
 *   `UPDLOCK, HOLDLOCK`, `CPA46` y `CPA36` con `UPDLOCK`.
 *
 * Los saldos de remito que consume la factura (`saldosDeRemitoEn`) se leen
 * sin bloqueo, pero el `UPDATE STA20` que los baja vuelve a exigir el saldo
 * en su `WHERE`; lo mismo `CPA46.FALTA_REM` en el remito.
 */
export async function registrarComprobante(id: number): Promise<RegistroTango> {
  return conTransaccion((tx) => registrarComprobanteEn(tx, id), sql.ISOLATION_LEVEL.READ_COMMITTED)
}
