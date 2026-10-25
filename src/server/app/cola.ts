import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { extraerDePdf, type Extraccion } from '../ia/extraccion'
import { buscarRemitoEnSta14, nCompRemito } from '../tango/remitosCompra'
import { buscarProveedoresPorCuit } from '../tango/proveedores'
import { buscarConceptoProveedor } from '../tango/conceptos'
import { sinonimosDelProveedor } from '../tango/articulos'
import { buscarRemitoPorNumero } from '../tango/remitos'
import { extraerRenglonesFacturados } from '../ia/renglones'
import {
  cotejarRenglones,
  describirDiferencias,
  type LineaRemito,
  type RenglonFacturado,
} from '@/lib/cotejo'
import { normalizarCuit, parsearImporte, parsearImporteONulo, formatFecha } from '@/lib/formato'
import {
  tipoFacturaODefault,
  analizaCampo,
  CLAVES_REMITO,
  TIPOS_FACTURA,
  TIPO_FACTURA_DEFAULT,
  vaContraOc,
  type TipoFactura,
} from '@/lib/tipoFactura'
import { planificarPercepcionIva } from '@/lib/percepcionIva'
import { MAX_SLOTS_IVA } from '@/lib/alicuotas'
import { MAX_SLOTS_VARIOS } from '@/lib/percepciones'
import {
  MOTIVO_SIN_CONCEPTO,
  MOTIVO_REMITO_SIN_SALDO,
  MOTIVO_FACTURA_NO_COINCIDE,
} from '@/lib/observacion'
import { guardarExtraccionEn, guardarCampoEn, auditarEn, obtenerDetalleEn } from './detalle'
import { guardarPdf, leerPdf } from './archivos'
import { cargarAprendidosEn } from './aprendizajeImpuestos'
import { usuarioActual } from '@/lib/usuario'
import { normalizarTextoCondicion } from '@/server/tango/condicionesCompra'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
import {
  letraComprobante,
  nComp as armarNComp,
  netoQueImplicaElIva,
  normalizarFechaArg,
  netoCierraConIva,
  parsearFechaArg,
} from '@/lib/validaciones'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverDescuentoDeDetalle, netoCorregido } from '@/lib/descuentoGlobal'
import { recalcularAVincularEn } from './ordenCompra'
import { aprenderLecturaEn } from './aprenderLectura'
import { fechaContableDe } from '@/lib/fechaContable'
import { cierreContable } from '@/server/tango/parametros'
import { listarAlicuotasIva } from '@/server/tango/impuestos'

export const MAX_INTENTOS = 3
export const MINUTOS_REPESCA = 10
export const CONCURRENCIA = 3

/** "CONTADO 1 DIA". Todas las facturas de conceptos arrancan con esta. */
export const COND_COMPRA_CONCEPTOS = '2'

/**
 * La letra con la que se archivan las liquidaciones de tarjeta. Verificado
 * contra CPA04: las 24 liquidaciones ya cargadas de los tres proveedores de
 * tarjeta/banco (VALLE FERTIL, Banco de Santiago del Estero, Banco Macro)
 * son todas 'A', sin una sola excepcion. A diferencia del punto de venta
 * --que cambia de proveedor a proveedor y por eso se aprende-- esta es una
 * constante real, asi que no hay nada que aprender.
 */
export const LETRA_TARJETA = 'A'

/**
 * El punto de venta con el que se archivan las liquidaciones de tarjeta
 * cuando el comprobante no lo imprime. Decision explicita del usuario
 * (2026-09-05).
 *
 * Reemplaza al aprendizaje por proveedor que habia hasta ayer. Ese
 * aprendizaje se habia construido sobre lo que figura en CPA04 --VALLE
 * FERTIL y el Banco de Santiago del Estero con '00000', el Banco Macro con
 * '10077'--, pero el usuario decidio unificar en '00001' de aca en
 * adelante, sabiendo que los N_COMP nuevos no van a continuar esas series
 * viejas. Queda escrito para que la discrepancia con CPA04 no se lea como
 * un bug.
 *
 * Solo aplica si el comprobante no lo trae: hay liquidaciones que si lo
 * imprimen --las de Tarjeta Naranja traen '0632'-- y ahi manda el documento.
 */
export const PTOVTA_TARJETA = '00001'
const INTERVALO_MS = 2 * 60 * 1000

type Ejecutor = { request(): sql.Request }

export type Pendiente = { id: number; ruta: string; tipoFactura: TipoFactura }

/**
 * El punto de entrada real al pipeline, sin importar de donde vino el PDF
 * (carga manual en `acciones.ts`, o el escaneo automatico de carpetas en
 * `carpetas.ts`): guarda el archivo, inserta la fila en 'procesando' y
 * audita el alta. No llama a la IA -- eso lo hace `procesarUno`, mas abajo,
 * cuando el worker (`tanda()`) la levante.
 */
export async function importarComprobanteEn(
  e: Ejecutor,
  nombre: string,
  datos: Buffer,
  tipoFactura: TipoFactura = TIPO_FACTURA_DEFAULT,
  origen: string = 'carga manual',
): Promise<number> {
  const { ruta, hash } = await guardarPdf(nombre, datos)

  const r = await e
    .request()
    .input('nombre', sql.NVarChar(260), nombre.slice(0, 260))
    .input('ruta', sql.NVarChar(500), ruta)
    .input('hash', sql.Char(64), hash)
    .input('tipoFactura', sql.VarChar(20), tipoFactura)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_COMPROBANTE
        (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO_FACTURA, USUARIO_ALTA)
      OUTPUT INSERTED.ID
      VALUES (@nombre, @ruta, @hash, 'procesando', @tipoFactura, @usuario)
    `)

  const id = Number(r.recordset[0].ID)
  const etiqueta = TIPOS_FACTURA.find((t) => t.clave === tipoFactura)?.label ?? tipoFactura
  await auditarEn(e, id, `PDF importado desde ${origen} — ${etiqueta}`)
  return id
}

/**
 * Los comprobantes que hay que extraer: los recien encolados y los que
 * quedaron colgados en `procesando`. Un comprobante queda colgado cuando
 * el server se reinicia o se cae en medio de la extraccion; sin la
 * repesca se quedaria ahi para siempre.
 *
 * La ventana de repesca se mide contra FECHA_MODIF, que se toca en cada
 * intento, y no contra FECHA_ALTA: si no, un comprobante en su tercer
 * intento se repescaria de inmediato.
 *
 * La seleccion es tambien el claim: el UPDATE marca FECHA_MODIF = SYSDATETIME()
 * en la misma sentencia que elige las filas, con UPDLOCK + READPAST sobre el
 * SELECT de la CTE para que dos ejecuciones concurrentes (por ejemplo
 * `tanda()` drenando la cola mientras otro llamado hace `despertarWorker()`)
 * no puedan tomar la misma fila -- una toma el lock de actualizacion y la
 * otra la saltea en vez de esperarla o releerla. Mismo espiritu que el
 * `MERGE ... WITH (HOLDLOCK)` de `guardarCampoEn` en detalle.ts.
 */
export async function tomarPendientesEn(e: Ejecutor, limite: number): Promise<Pendiente[]> {
  const r = await e
    .request()
    .input('lim', sql.Int, limite)
    .input('max', sql.Int, MAX_INTENTOS)
    .input('min', sql.Int, MINUTOS_REPESCA)
    .query<Record<string, unknown>>(`
      WITH candidatos AS (
        SELECT TOP (@lim) ID, ARCHIVO_RUTA, TIPO_FACTURA, FECHA_MODIF
        FROM PHF_COMPROBANTE WITH (UPDLOCK, ROWLOCK, READPAST)
        WHERE ESTADO = 'procesando'
          AND INTENTOS < @max
          AND (FECHA_MODIF IS NULL OR FECHA_MODIF < DATEADD(MINUTE, -@min, SYSDATETIME()))
        ORDER BY FECHA_ALTA
      )
      UPDATE candidatos
      SET FECHA_MODIF = SYSDATETIME()
      OUTPUT INSERTED.ID, INSERTED.ARCHIVO_RUTA, INSERTED.TIPO_FACTURA
    `)

  return r.recordset.map((x) => ({
    id: Number(x.ID),
    ruta: String(x.ARCHIVO_RUTA),
    // Los comprobantes importados antes de que existiera la columna la
    // tienen en NULL. Caen al default en vez de fallar: son facturas de
    // conceptos en su enorme mayoria, y colgar la cola por un dato viejo
    // seria peor que leerlas con el prompt mas comun.
    tipoFactura: tipoFacturaODefault(x.TIPO_FACTURA as string | null),
  }))
}

export async function marcarLeidoEn(
  e: Ejecutor,
  id: number,
  confianzaPromedio: number,
  ms: number,
  modelo: string,
  campos: number,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('conf', sql.Decimal(5, 4), confianzaPromedio)
    .input('ms', sql.Int, ms)
    .input('modelo', sql.VarChar(40), modelo)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'leido',
          CONFIANZA_PROMEDIO = @conf,
          EXTRACCION_MS = @ms,
          EXTRACCION_MODELO = @modelo,
          ERROR_MENSAJE = NULL,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  const seg = (ms / 1000).toFixed(1).replace('.', ',')
  await auditarEn(e, id, `Lectura automática con IA — ${campos} campos en ${seg} s`)
}

/**
 * Suma un intento. Si quedan reintentos lo deja en `procesando` para que
 * la repesca lo vuelva a tomar; si se agotaron, lo pasa a `error`.
 */
export async function marcarFalloEn(e: Ejecutor, id: number, error: string): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, id)
    .input('err', sql.NVarChar(1000), error.slice(0, 1000))
    .input('max', sql.Int, MAX_INTENTOS)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET INTENTOS = INTENTOS + 1,
          ERROR_MENSAJE = @err,
          ESTADO = CASE WHEN INTENTOS + 1 >= @max THEN 'error' ELSE 'procesando' END,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(e, id, `Falló la lectura automática: ${error}`.slice(0, 500))
}

/**
 * Copia a las columnas de `PHF_COMPROBANTE` los campos que la bandeja
 * muestra. Sin esto la bandeja quedaría con las columnas vacías: la
 * bandeja lee de la tabla, no de PHF_CAMPO, para no hacer 21 joins por
 * fila con 100 comprobantes en pantalla.
 *
 * La fecha se convierte en SQL porque la columna es DATE y `TRY_CONVERT`
 * alcanza. El total se parsea en JS con `parsearImporteONulo`: las
 * facturas reales mezclan separadores en el mismo comprobante ("186623.75"
 * al lado de "39.190,99"), y `REPLACE('.', '').REPLACE(',', '.')` a ciegas
 * arruina justamente el formato sin coma. Si la IA leyó algo que no
 * parsea, la columna queda NULL en vez de fallar toda la extracción por
 * un campo.
 */
export async function desnormalizarBandejaEn(
  e: Ejecutor,
  id: number,
  extraccion: Extraccion,
): Promise<void> {
  const v = (clave: string) => extraccion.campos[clave]?.valor ?? null

  await e
    .request()
    .input('id', sql.Int, id)
    .input('tipo', sql.VarChar(10), v('tipo')?.slice(0, 10) ?? null)
    .input('pv', sql.VarChar(10), v('ptovta')?.slice(0, 10) ?? null)
    .input('nro', sql.VarChar(20), v('nro')?.slice(0, 20) ?? null)
    .input('cuit', sql.VarChar(15), v('cuit')?.slice(0, 15) ?? null)
    .input('total', sql.Decimal(19, 4), parsearImporteONulo(v('total')))
    // Canonica y truncada. Era el unico de los cinco sin .slice(), y una
    // factura que imprime "18 de Septiembre de 2026" --24 caracteres, mas que
    // el NVarChar(20)-- hacia que el driver rechazara el parametro y se
    // revirtiera la transaccion ENTERA: el comprobante no se importaba y el
    // operador solo veia "error de lectura" (WINNERS, 2026-09-23). Se
    // normaliza primero para que TRY_CONVERT tenga el formato que espera; si
    // no se puede interpretar se guarda recortada, y FECHA_EMISION queda
    // NULL -- que es lo que validarFecha le señala al operador.
    .input('fecha', sql.NVarChar(20), normalizarFechaArg(v('fecha')) ?? v('fecha')?.slice(0, 20) ?? null)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET TIPO = @tipo,
          PUNTO_VENTA = @pv,
          NUMERO = @nro,
          CUIT = @cuit,
          TOTAL = @total,
          FECHA_EMISION = TRY_CONVERT(DATE, @fecha, 103)
      WHERE ID = @id
    `)
}

/**
 * Busca el proveedor de Tango por el CUIT que leyó la IA y deja el código
 * en el campo `codprovee` y en la columna de bandeja. Si no matchea, o si
 * matchea a mas de uno (hay 7 CUIT duplicados en CPA01), no escribe nada:
 * la validación bloqueante y la resolución de CUIT duplicados son de la
 * Fase 3, y quedan para que el operador elija a mano desde el selector
 * manual -- escribir el primer match a ciegas dejaria un codigo de
 * proveedor arbitrario que la validacion bloqueante nunca detectaria.
 *
 * Es el único punto de la app fuera de src/server/tango/ que necesita un
 * dato del ERP, y lo pide por la función de esa capa: no emite SQL contra
 * CPA01 ni la nombra.
 */
export async function resolverProveedorEn(
  e: Ejecutor,
  id: number,
  cuit: string | null,
): Promise<string | null> {
  if (!cuit || !normalizarCuit(cuit)) return null

  const candidatos = await buscarProveedoresPorCuit(cuit)
  if (candidatos.length !== 1) return null
  const proveedor = candidatos[0]

  // No es una correccion del operador: lo resolvio el sistema por el CUIT.
  // CORREGIDO_POR_USUARIO en 1 aca contaminaria la metrica de que tan bien
  // lee el modelo, que es para lo que existe esa columna.
  await guardarCampoEn(e, id, 'codprovee', proveedor.codProvee, { corregidoPorUsuario: false })

  await e
    .request()
    .input('id', sql.Int, id)
    .input('cod', sql.VarChar(20), proveedor.codProvee)
    .input('razon', sql.NVarChar(200), proveedor.razonSocial)
    .query(`
      UPDATE PHF_COMPROBANTE SET COD_PROVEE = @cod, RAZON_SOCIAL = @razon WHERE ID = @id
    `)

  await auditarEn(e, id, `Proveedor resuelto por CUIT: ${proveedor.codProvee} — ${proveedor.razonSocial}`)
  return proveedor.codProvee
}

/**
 * Si esta factura de artículos todavía no tiene condición de compra
 * elegida y el proveedor ya le enseñó a la app a qué código de Tango
 * corresponde el texto de condición de pago/venta que imprime (`condpago`,
 * ver `CONDICION_PAGO` en tipoFactura.ts), la aplica sola -- mismo
 * mecanismo que `aprendizajeImpuestos.ts` usa para IVA/IIBB, ahora
 * también para condición de compra (tipo `'condicion'`). El operador la
 * sigue pudiendo cambiar desde el formulario; al hacerlo, se reaprende
 * (ver `cambiar()` en formulario.tsx).
 *
 * Conceptos y tarjeta no llaman a esto: ya arrancan con
 * `COND_COMPRA_CONCEPTOS` fija (ver más arriba), así que `condcompra` ya
 * está seteada para cuando este paso correría -- no hay nada que resolver.
 */
export async function resolverCondicionCompraEn(
  e: Ejecutor,
  id: number,
  codProvee: string | null,
  condicionTexto: string | null,
): Promise<void> {
  const prov = (codProvee ?? '').trim()
  const texto = (condicionTexto ?? '').trim()
  if (!prov || !texto) return

  const detalle = await obtenerDetalleEn(e, id)
  const yaTiene = (detalle.campos.find((c) => c.clave === 'condcompra')?.valorFinal ?? '').trim()
  if (yaTiene) return

  const aprendidos = await cargarAprendidosEn(e, prov, 'condicion')
  const cod = aprendidos[normalizarTextoCondicion(texto)]
  if (!cod) return

  await guardarCampoEn(e, id, 'condcompra', cod, { corregidoPorUsuario: false })
  await auditarEn(e, id, `Condición de compra aprendida para el proveedor: "${texto}" → código ${cod}`)
}

/**
 * Cálculo inverso: si el neto que salió de sumar los cargos no cierra
 * contra el IVA impreso, se reemplaza por el que ese IVA implica
 * (`importe ÷ alícuota`, sumando las alícuotas que gravan la base -- 21% y
 * 10,5% conviven sin problema, cada una aporta su parte).
 *
 * Decisión explícita del usuario. La razón es cuál de los dos datos es más
 * firme: el IVA viene impreso, rotulado y sin ambigüedad, mientras que el
 * neto hay que componerlo sumando cargos que cada procesadora rotula
 * distinto y que el modelo puede no encontrar todos. Cuando discrepan, el
 * IVA gana.
 *
 * Solo en tarjeta: en los otros tipos el neto viene impreso como tal, así
 * que no hay nada que reconstruir y una diferencia es información para el
 * operador, no algo para pisar.
 *
 * **Lo que este ajuste puede tapar, y por eso queda en la auditoría:** si
 * la que está mal es la línea de IVA y no el neto, el inverso arrastra el
 * error en vez de corregirlo -- pasó de verdad con una liquidación de Banco
 * Macro donde una percepción del 3% se leyó como alícuota del 21%, y el
 * inverso habría dado $208.868 en vez de $182.760. Después de este ajuste
 * el cotejo de la pantalla siempre cierra (lo acabamos de forzar), así que
 * la entrada de auditoría y el subtotal de la tarjeta de cargos son lo
 * único que deja ver que hubo un ajuste y contra qué.
 */
export async function ajustarNetoConIvaEn(
  e: Ejecutor,
  id: number,
  codProvee: string | null,
): Promise<{ ajustado: boolean; neto: number | null; sumaCargos: number | null }> {
  const detalle = await obtenerDetalleEn(e, id)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const prov = (codProvee ?? '').trim()
  const aprendidos = prov ? await cargarAprendidosEn(e, prov, 'iva') : {}
  const lineas = resolverAlicuotas(valores, await listarAlicuotasIva(), aprendidos)

  const esperado = netoQueImplicaElIva(lineas)
  const actual = parsearImporte(valores.neto)
  // Sin lineas de IVA utilizables no hay inverso que aplicar.
  if (esperado === null) return { ajustado: false, neto: null, sumaCargos: actual }
  if (netoCierraConIva(esperado, actual)) return { ajustado: false, neto: actual, sumaCargos: actual }

  await guardarCampoEn(e, id, 'neto', esperado.toFixed(2).replace('.', ','), {
    corregidoPorUsuario: false,
  })
  return { ajustado: true, neto: esperado, sumaCargos: actual }
}

/**
 * En una factura de artículos con descuento general al pie, deja en `neto`
 * la base gravada REAL.
 *
 * Hay proveedores que imprimen "Neto Gravado" con la suma de los subtotales
 * ANTES del descuento general (ZOZZOLI: 1.106.082,67 impreso, 998.239,61
 * real). La IA copia lo impreso -- es lo que se le pide -- y el IVA lo
 * contradice. `resolverDescuentoDeDetalle` decide con el IVA cuál es la
 * base; si el campo de la revisión no coincide, se reemplaza, con línea en
 * el historial. Solo corrige cuando resolvió con el IVA como evidencia (ver
 * `netoCorregido`): sin esa confirmación no pisa lo leído.
 *
 * Va después de `mudarPercepcionIvaEn`, para que los slots de IVA ya estén
 * acomodados, y no toca conceptos ni tarjeta: ahí no hay renglones.
 */
export async function corregirNetoTrasDescuentoEn(
  e: Ejecutor,
  id: number,
  codProvee: string | null,
  tipoFactura: string,
): Promise<void> {
  if (tipoFactura !== 'articulos') return
  const detalle = await obtenerDetalleEn(e, id)
  if (detalle.renglonesPdf.length === 0) return
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const prov = (codProvee ?? '').trim()
  const aprendidos = prov ? await cargarAprendidosEn(e, prov, 'iva') : {}
  const lineas = resolverAlicuotas(valores, await listarAlicuotasIva(), aprendidos)
  const resultado = resolverDescuentoDeDetalle(
    detalle.renglonesPdf,
    valores.descuentogeneral,
    valores.neto,
    netoQueImplicaElIva(lineas),
  )
  const corregido = netoCorregido(resultado)
  if (corregido === null || !resultado.ok) return

  await guardarCampoEn(e, id, 'neto', corregido, { corregidoPorUsuario: false })
  await auditarEn(
    e,
    id,
    `Neto gravado corregido a ${corregido}: la factura imprime ${valores.neto ?? '—'} antes del ` +
      `descuento general de ${resultado.descuentoGeneral.toFixed(2)}, y el IVA impreso confirma la base real`,
  )
}

/**
 * Calcula la fecha contable del comprobante y la guarda.
 *
 * Es la de emisión, salvo que el comprobante caiga dentro del período que
 * Tango tiene cerrado (`CPA10.CIERRE_CON`): ahí va al primer día del mes
 * siguiente al cierre, que es el primer período abierto. La regla vive en
 * `src/lib/fechaContable.ts` y la usan los dos lados -- esta función y el
 * formulario, que la recalcula cuando el operador corrige la fecha de
 * emisión -- para que no puedan discrepar.
 *
 * No pisa una corrección del operador: si ya la tocó a mano, esa gana.
 * Devuelve la fecha que quedó, o `null` si no hay fecha de emisión válida
 * todavía (ahí no hay nada que calcular y el campo queda vacío).
 */
export async function calcularFechaContableEn(
  e: Ejecutor,
  id: number,
  fechaComprobante?: string | null,
): Promise<string | null> {
  const detalle = await obtenerDetalleEn(e, id)
  const campo = (clave: string) => detalle.campos.find((c) => c.clave === clave)

  if (campo('fechacontable')?.corregido) return campo('fechacontable')?.valorFinal ?? null

  const texto = (fechaComprobante ?? campo('fecha')?.valorFinal ?? '').trim()
  const emision = texto ? parsearFechaArg(texto) : null
  if (!emision) return null

  const contable = fechaContableDe(emision, await cierreContable())
  const valor = formatFecha(contable)
  await guardarCampoEn(e, id, 'fechacontable', valor, { corregidoPorUsuario: false })
  return valor
}

/**
 * Manda a los slots de IVA las percepciones de IVA que la IA dejó en los de
 * impuestos varios (ver `src/lib/percepcionIva.ts` para el porqué).
 *
 * Corre en los tres tipos, no solo en tarjeta: el callejón sin salida que
 * arregla --el desplegable de varios no ofrece, ni puede ofrecer, los
 * códigos de percepción de IVA-- es el mismo en una factura de conceptos.
 *
 * Es una red, no el arreglo principal: el prompt ya le pide al modelo que
 * las ponga donde van. Existe porque este es justo el dato que el modelo
 * lee peor -- en la liquidación que lo destapó lo devolvió con 0,60 de
 * confianza, la más baja del comprobante.
 *
 * Devuelve cuántas mudó. Lo que reconoció pero no pudo mudar por falta de
 * par de IVA libre queda en la auditoría: es un caso que nadie vio todavía
 * y no conviene que pase en silencio.
 */
export async function mudarPercepcionIvaEn(
  e: Ejecutor,
  id: number,
  tipoFactura: TipoFactura,
): Promise<number> {
  const detalle = await obtenerDetalleEn(e, id)
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const slots = (max: number, prefijo: string) =>
    Array.from({ length: max }, (_, i) => i + 1).filter((n) =>
      analizaCampo(tipoFactura, `${prefijo}${n}`),
    )

  const plan = planificarPercepcionIva(
    valores,
    slots(MAX_SLOTS_IVA, 'impiva'),
    slots(MAX_SLOTS_VARIOS, 'varios'),
  )

  for (const { clave, valor } of plan.escrituras) {
    await guardarCampoEn(e, id, clave, valor, { corregidoPorUsuario: false })
  }

  if (plan.mudados.length > 0) {
    await auditarEn(
      e,
      id,
      `Percepción de IVA movida de impuestos varios a los slots de alícuota: ` +
        plan.mudados.join(', ').slice(0, 150),
    )
  }
  if (plan.sinLugar > 0) {
    await auditarEn(
      e,
      id,
      `${plan.sinLugar} percepción(es) de IVA quedaron en impuestos varios: ` +
        `no hay par de alícuota libre para moverlas`,
    )
  }

  return plan.mudados.length
}

/**
 * Marca como no gravados los cargos cuyo rótulo este proveedor ya enseñó
 * que no suma a la base. Corre antes de `recalcularNetoDeCargosEn`, para
 * que el neto salga bien de entrada.
 *
 * Cada procesadora mantiene su formato mes a mes, así que alcanza con que
 * el operador lo corrija una vez: la liquidación siguiente ya viene bien
 * sin que toque nada. Solo se aplica lo aprendido como NO gravado -- el
 * default de la tabla ya es que todo suma, así que no hay nada que hacer
 * con lo aprendido en el otro sentido.
 */
export async function aplicarCargosAprendidosEn(
  e: Ejecutor,
  id: number,
  codProvee: string | null,
): Promise<number> {
  const prov = (codProvee ?? '').trim()
  if (!prov) return 0

  const aprendidos = await cargarAprendidosEn(e, prov, 'gravado')
  const noGravados = Object.entries(aprendidos)
    .filter(([, v]) => v === 'N')
    .map(([rotulo]) => rotulo)
  if (noGravados.length === 0) return 0

  const detalle = await obtenerDetalleEn(e, id)
  let marcados = 0
  for (const c of detalle.cargos) {
    if (!c.concepto || !noGravados.includes(normalizarTextoCondicion(c.concepto))) continue
    await e
      .request()
      .input('id', sql.Int, c.id)
      .query('UPDATE PHF_CARGO SET GRAVADO = 0 WHERE ID = @id')
    marcados += 1
  }
  return marcados
}

/**
 * Recalcula el neto gravado sumando los cargos marcados como gravados, y lo
 * escribe en el campo `neto`.
 *
 * Es el punto de todo el desglose: la suma la hace la base, con aritmética
 * decimal exacta, en vez de hacerla el modelo de memoria. Leyendo el mismo
 * PDF dos veces la IA habia devuelto dos netos distintos --uno con un cargo
 * de menos-- mientras que los cargos por separado los transcribe bien.
 *
 * Devuelve el neto calculado, o `null` si el comprobante no tiene cargos
 * (cualquier tipo que no sea tarjeta, o una liquidacion donde el modelo no
 * pudo desglosar nada: ahi se respeta lo que haya leido en `neto`).
 */
export async function recalcularNetoDeCargosEn(
  e: Ejecutor,
  id: number,
): Promise<number | null> {
  const r = await e
    .request()
    .input('id', sql.Int, id)
    .query<{ cuantos: number; suma: number | null }>(`
      SELECT COUNT(*) AS cuantos, SUM(CASE WHEN GRAVADO = 1 THEN IMPORTE ELSE 0 END) AS suma
      FROM PHF_CARGO WHERE COMPROBANTE_ID = @id
    `)
  const fila = r.recordset[0]
  if (!fila || Number(fila.cuantos) === 0) return null

  const neto = Math.round(Number(fila.suma ?? 0) * 100) / 100
  await guardarCampoEn(e, id, 'neto', neto.toFixed(2).replace('.', ','), {
    corregidoPorUsuario: false,
  })
  return neto
}

/**
 * Completa la identificación que una liquidación de tarjeta no trae impresa:
 * la letra (`LETRA_TARJETA`) y el punto de venta (`PTOVTA_TARJETA`). Sin las
 * dos, `registrarComprobanteEn` corta con "No se pudo determinar la letra
 * del comprobante" y `validarFormatoNComp` bloquea por falta de punto de
 * venta -- una liquidación quedaba imposible de registrar sin que el
 * operador tipeara los dos campos a mano en cada una.
 *
 * Las dos se completan SOLO si están vacías: si la liquidación imprimió su
 * letra o su punto de venta y la IA los leyó, gana el documento -- las de
 * Tarjeta Naranja, por ejemplo, traen el punto de venta '0632'. Un default
 * que pisa un dato real es peor que no tener default.
 *
 * `codProvee` ya no se usa: quedó cuando el punto de venta se aprendía por
 * proveedor. Se mantiene en la firma porque el llamador lo tiene a mano y
 * sacarlo obligaría a tocar el pipeline sin ganar nada.
 */
export async function completarIdentificacionTarjetaEn(
  e: Ejecutor,
  id: number,
  _codProvee?: string | null,
): Promise<void> {
  const detalle = await obtenerDetalleEn(e, id)
  const valorDe = (clave: string) =>
    (detalle.campos.find((c) => c.clave === clave)?.valorFinal ?? '').trim()

  let letra: string | null = null
  if (!valorDe('tipo')) {
    letra = LETRA_TARJETA
    await guardarCampoEn(e, id, 'tipo', letra, { corregidoPorUsuario: false })
    await auditarEn(e, id, `Letra completada para liquidación de tarjeta: ${letra}`)
  }

  let ptovta: string | null = null
  if (!valorDe('ptovta')) {
    ptovta = PTOVTA_TARJETA
    await guardarCampoEn(e, id, 'ptovta', ptovta, { corregidoPorUsuario: false })
    await auditarEn(e, id, `Punto de venta completado para liquidación de tarjeta: ${ptovta}`)
  }

  if (!letra && !ptovta) return

  // Las columnas de bandeja no las escribe guardarCampoEn, sino
  // desnormalizarBandejaEn desde la extraccion -- que para estos dos campos
  // vino vacia. Sin esta actualizacion la bandeja mostraria la liquidacion
  // sin letra ni punto de venta pese a que el formulario ya los tiene, y el
  // chequeo de duplicados de validaciones.ts, que busca por PUNTO_VENTA y
  // NUMERO en esta misma tabla, no encontraria nada.
  //
  // COALESCE y no asignacion directa: cada campo se completa por separado,
  // y el que no se completo en esta pasada tiene que quedar como estaba.
  await e
    .request()
    .input('id', sql.Int, id)
    .input('tipo', sql.VarChar(10), letra)
    .input('pv', sql.VarChar(10), ptovta)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET TIPO = COALESCE(@tipo, TIPO),
          PUNTO_VENTA = COALESCE(@pv, PUNTO_VENTA)
      WHERE ID = @id
    `)
}

/**
 * Si esta factura ya existe registrada en Tango (mismo proveedor y mismo
 * número de comprobante en CPA04), la pasa al estado `'existente'` en vez
 * de dejarla como una más para revisar -- decisión del usuario: no tiene
 * sentido pedirle al operador que revise ni que intente registrar algo
 * que ya está cargado, y menos que llegue a intentar el registro real y
 * lo bloquee recién ahí. Mismo criterio de "clasificar sola en la
 * importación" que `observarSinConceptoEn`, con la misma fuente
 * (`buscarFacturaEnCpa04`) que ya usaba la validación de Fase 3 para
 * avisar de un duplicado -- acá se actúa temprano en vez de solo avisar
 * tarde.
 *
 * No confundir con un duplicado *dentro de esta app* (la misma factura
 * importada dos veces, todavía sin registrar en Tango): ese caso sigue
 * siendo un error de Fase 3 que el operador tiene que notar y resolver
 * borrando uno de los dos, no algo que se pueda auto-clasificar como "ya
 * existe en Tango" porque sería falso.
 */
export async function marcarExistenteEnTangoEn(
  e: Ejecutor,
  id: number,
  codProvee: string | null,
  valores: Record<string, string | null | undefined>,
): Promise<boolean> {
  if (!codProvee) return false

  // Un remito se busca en Stock (STA14), no en Compras: ver remitosCompra.ts.
  if (valores.tipoFactura === 'remito') {
    const ptovtaR = (valores.ptovta ?? '').trim()
    const nroR = (valores.nro ?? '').trim()
    if (!ptovtaR || !nroR) return false
    const remito = await buscarRemitoEnSta14(codProvee, nCompRemito(ptovtaR, nroR))
    if (!remito) return false
    await e
      .request()
      .input('id', sql.Int, id)
      .query(`UPDATE PHF_COMPROBANTE SET ESTADO = 'existente', FECHA_MODIF = SYSDATETIME() WHERE ID = @id`)
    await auditarEn(
      e,
      id,
      `Ya existe en Tango: remito ${remito.nComp} (interno RP ${remito.ncompInS}) — no se puede volver a registrar`,
    )
    return true
  }

  const letra = letraComprobante(valores.tipo ?? '')
  const ptovta = (valores.ptovta ?? '').trim()
  const nro = (valores.nro ?? '').trim()
  if (!letra || !ptovta || !nro) return false

  const nComprobante = armarNComp(letra, ptovta, nro)
  const enTango = await buscarFacturaEnCpa04(codProvee, nComprobante)
  if (!enTango) return false

  await e
    .request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'existente', FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(
    e,
    id,
    `Ya existe en Tango: factura ${enTango.nComp} (proveedor ${enTango.codProvee}) — no se puede volver a registrar`,
  )
  return true
}

/**
 * Manda a observacion la factura de conceptos cuyo proveedor no tiene un
 * concepto asociado en Tango.
 *
 * El concepto es contra que cuenta se imputa el comprobante: sin el no hay
 * registro posible, y no es algo que el operador pueda resolver desde esta
 * app -- se carga en la ficha del proveedor, en Tango. Dejarlo en
 * "pendiente de revision" lo manda a revisar un comprobante que no va a
 * poder confirmar, y recien se entera al final. En observacion sale de la
 * fila de trabajo y queda con el motivo escrito.
 *
 * Corre despues de `marcarLeidoEn` a proposito: esa funcion pone el estado
 * en 'leido', asi que hacerlo antes lo pisaria.
 *
 * Devuelve si lo observo, para el log de la tanda.
 */
export async function observarSinConceptoEn(
  e: Ejecutor,
  id: number,
  tipoFactura: TipoFactura,
  codProvee: string | null,
): Promise<boolean> {
  // Solo las facturas de conceptos: una de articulos se imputa por renglon,
  // y una liquidacion de tarjeta va al concepto fijo de comisiones, que no
  // depende de la ficha del proveedor y por lo tanto nunca falta por esta
  // via. Mismo criterio que validarListoParaRegistrar.
  if (tipoFactura !== 'conceptos') return false

  // Sin proveedor resuelto no se puede saber si tiene concepto. Ese caso ya
  // lo marca la validacion de proveedor, y mandarlo a observacion por algo
  // que todavia no se pudo evaluar seria culpar al proveedor equivocado.
  if (!codProvee) return false

  const concepto = await buscarConceptoProveedor(codProvee)
  if (concepto) return false

  const nota =
    `El proveedor ${codProvee} no tiene un concepto asociado en Tango, así que ` +
    `no hay contra qué cuenta imputar el comprobante. Cargalo en la ficha del ` +
    `proveedor y volvé a revisarlo.`

  await e
    .request()
    .input('id', sql.Int, id)
    .input('motivo', sql.NVarChar(60), MOTIVO_SIN_CONCEPTO)
    .input('nota', sql.NVarChar(1000), nota)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'observacion',
          MOTIVO_OBSERVACION = @motivo,
          NOTA_OBSERVACION = @nota,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(e, id, `En observación: ${MOTIVO_SIN_CONCEPTO} (${codProvee})`)
  return true
}

/** Lo que la carga de renglones desde el remito dejo, para el log y los tests. */
export type CargaRemitos = {
  /** Renglones escritos en PHF_RENGLON. */
  renglones: number
  /** Numeros que Tango tiene sin mercaderia pendiente. */
  sinSaldo: string[]
  /** Numeros que no existen para ese proveedor. */
  noEncontrados: string[]
}

/**
 * Resuelve contra Tango los remitos que la IA leyo en la cabecera y
 * devuelve sus renglones numerados, listos para que la segunda pasada de
 * extraccion los empareje con los de la factura.
 *
 * No escribe nada: separar la lectura de Tango de la escritura permite
 * hacer el llamado a la IA sin una transaccion abierta.
 */
export async function lineasDeRemitos(
  tipoFactura: TipoFactura,
  codProvee: string | null,
  valores: Record<string, string | null>,
): Promise<{ lineas: LineaRemito[]; origen: Map<number, OrigenRenglon>; carga: CargaRemitos }> {
  const vacio = {
    lineas: [] as LineaRemito[],
    origen: new Map<number, OrigenRenglon>(),
    carga: { renglones: 0, sinSaldo: [], noEncontrados: [] } as CargaRemitos,
  }
  if (tipoFactura !== 'articulos' || !codProvee) return vacio

  const numeros = CLAVES_REMITO.map((k) => (valores[k] ?? '').trim()).filter((n) => n !== '')
  if (numeros.length === 0) return vacio

  const lineas: LineaRemito[] = []
  const origen = new Map<number, OrigenRenglon>()
  const carga: CargaRemitos = { renglones: 0, sinSaldo: [], noEncontrados: [] }

  for (const numero of numeros) {
    const r = await buscarRemitoPorNumero(codProvee, numero)

    if (r.estado === 'sin-saldo') {
      carga.sinSaldo.push(numero)
      continue
    }
    if (r.estado === 'no-existe') {
      carga.noEncontrados.push(numero)
      continue
    }

    for (const renglon of r.remito.renglones) {
      // El indice es correlativo entre TODOS los remitos de la factura: la
      // IA ve una sola lista, no una por remito.
      const indice = lineas.length + 1
      lineas.push({
        indice,
        codArticulo: renglon.codArticulo,
        descripcion: renglon.descripcion,
        // Se coteja contra la cantidad PENDIENTE: si parte del remito ya se
        // facturo, lo que esta factura tiene que cobrar es el saldo.
        cantidad: renglon.cantidadPendiente,
        numeroRemito: r.remito.numero,
      })
      origen.set(indice, {
        ncompInS: r.remito.numeroInterno,
        nRenglon: renglon.nRenglon,
        numero: r.remito.numero,
      })
    }
  }

  // Lo que el operador ya enseño en CPA15: si este proveedor tiene cargado
  // el codigo con el que llama a alguno de estos articulos, se lo pasamos al
  // modelo. Cierra el ciclo -- una correccion manual mejora el
  // emparejamiento automatico de la proxima factura.
  const sinonimos = await sinonimosDelProveedor(
    codProvee,
    lineas.map((l) => l.codArticulo),
  )
  for (const l of lineas) l.codigoProveedor = sinonimos.get(l.codArticulo) ?? null

  return { lineas, origen, carga }
}

/** De qué renglón de Tango salió cada línea, para el join al registrar. */
export type OrigenRenglon = { ncompInS: string; nRenglon: number; numero: string }

/**
 * Escribe los renglones de la factura en PHF_RENGLON.
 *
 * Lo que se guarda es lo que la FACTURA cobra -- cantidad y precio
 * unitario --, no lo que dice el remito. El remito no es valorizado
 * (decision del usuario, 2026-08-20): dice que entro y cuanto, y el precio
 * sale de la factura. Cada renglon conserva el link al renglon del remito
 * que le corresponde, que es la clave del join contra STA20 al registrar.
 *
 * Los renglones que la factura cobra y no estan en ningun remito se
 * guardan igual, sin link: el operador tiene que verlos, y el cotejo ya los
 * marco como diferencia.
 */
export async function guardarRenglonesFacturadosEn(
  e: Ejecutor,
  id: number,
  facturados: RenglonFacturado[],
  origen: Map<number, OrigenRenglon>,
  lineas: LineaRemito[],
): Promise<number> {
  let orden = 0

  for (const f of facturados) {
    const linea = lineas.find((l) => l.indice === f.lineaRemito) ?? null
    const o = linea ? (origen.get(linea.indice) ?? null) : null
    orden += 1

    const cantidad = parsearImporteONulo(f.cantidad)
    const precio = parsearImporteONulo(f.precioUnitario)
    // El precio impreso es el de lista; el importe de la linea ya viene con
    // el descuento aplicado. Se guarda el bruto en PRECIO_UNITARIO_IA -- es
    // lo que el operador ve en el papel -- y el importe YA NETO, para que la
    // suma de los renglones cierre contra el neto gravado de la cabecera.
    const bonif = parsearImporteONulo(f.bonificacion)
    const neto = precio !== null && bonif !== null ? precio * (1 - bonif / 100) : precio

    await e
      .request()
      .input('id', sql.Int, id)
      .input('orden', sql.Int, orden)
      // El codigo es el NUESTRO cuando se pudo emparejar: es con el que se
      // graba en Tango. La descripcion, en cambio, es la del proveedor, que
      // es lo que el operador ve impreso en el papel.
      .input('codigo', sql.NVarChar(60), linea ? linea.codArticulo : null)
      .input('desc', sql.NVarChar(500), f.descripcion)
      .input('cant', sql.Decimal(19, 4), cantidad)
      .input('pu', sql.Decimal(19, 4), precio)
      .input('bonif', sql.Decimal(9, 4), bonif)
      .input('codProv', sql.NVarChar(60), f.codigoProveedor)
      .input(
        'imp',
        sql.Decimal(19, 4),
        cantidad !== null && neto !== null ? cantidad * neto : null,
      )
      .input('ncompInS', sql.VarChar(20), o ? o.ncompInS : null)
      .input('nRenglS', sql.Int, o ? o.nRenglon : null)
      .input('numero', sql.VarChar(20), o ? o.numero : null)
      // Lo que entrego el remito de este renglon. Se guarda junto a lo que
      // factura el proveedor para que la pantalla pueda mostrar las dos
      // cantidades y el operador vea de un vistazo si coinciden.
      .input('cantRemito', sql.Decimal(19, 4), linea ? linea.cantidad : null)
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA,
           CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA,
           REMITO_NCOMP_IN_S, REMITO_N_RENGL_S, REMITO_NUMERO, CANTIDAD_REMITO,
           PORC_BONIF, COD_PROVEEDOR)
        VALUES (@id, @orden, @codigo, @desc, @cant, @pu, @imp, @ncompInS, @nRenglS,
                @numero, @cantRemito, @bonif, @codProv)
      `)
  }

  return orden
}

/**
 * Manda a observacion la factura de articulos cuyos remitos no se pudieron
 * usar. Son dos problemas distintos y el mensaje lo dice:
 *
 *   sin saldo   el remito existe pero ya esta facturado. Suele ser el
 *               proveedor facturando dos veces la misma mercaderia, y no
 *               es algo que se resuelva corrigiendo un campo.
 *   no existe   el numero no aparece para ese proveedor. Casi siempre es
 *               un numero mal leido o un remito que todavia no se cargo.
 */
export async function observarRemitosEn(
  e: Ejecutor,
  id: number,
  carga: CargaRemitos,
): Promise<boolean> {
  const problemas: string[] = []
  if (carga.sinSaldo.length > 0) {
    problemas.push(
      `${carga.sinSaldo.join(', ')} ya está facturado por completo en Tango: no queda ` +
        `mercadería pendiente para asociar.`,
    )
  }
  if (carga.noEncontrados.length > 0) {
    problemas.push(
      `${carga.noEncontrados.join(', ')} no aparece entre los remitos de este proveedor. ` +
        `Puede estar mal leído, o el remito todavía no se cargó en Tango.`,
    )
  }
  if (problemas.length === 0) return false

  const nota = `Remito ${problemas.join(' Remito ')}`

  await e
    .request()
    .input('id', sql.Int, id)
    .input('motivo', sql.NVarChar(60), MOTIVO_REMITO_SIN_SALDO)
    .input('nota', sql.NVarChar(1000), nota.slice(0, 1000))
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'observacion',
          MOTIVO_OBSERVACION = @motivo,
          NOTA_OBSERVACION = @nota,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(e, id, `En observación: ${MOTIVO_REMITO_SIN_SALDO}`)
  return true
}

/**
 * Manda a observacion la factura de articulos que no coincide con su
 * remito, con el detalle de las diferencias en la nota.
 *
 * La norma es igualdad estricta -- la factura cubre el remito entero --,
 * asi que cualquier diferencia frena el comprobante. Va con el detalle
 * escrito y no solo con el motivo porque el operador tiene que poder ir al
 * papel a verificar cual de las dos partes se equivoco sin volver a abrir
 * Tango.
 */
export async function observarDiferenciasEn(
  e: Ejecutor,
  id: number,
  diferencias: ReturnType<typeof cotejarRenglones>,
): Promise<boolean> {
  if (diferencias.length === 0) return false

  const detalle = describirDiferencias(diferencias)
  const nota = `La factura no coincide con el remito: ${detalle.join(' ')}`

  await e
    .request()
    .input('id', sql.Int, id)
    .input('motivo', sql.NVarChar(60), MOTIVO_FACTURA_NO_COINCIDE)
    .input('nota', sql.NVarChar(1000), nota.slice(0, 1000))
    .query(`
      UPDATE PHF_COMPROBANTE
      SET ESTADO = 'observacion',
          MOTIVO_OBSERVACION = @motivo,
          NOTA_OBSERVACION = @nota,
          FECHA_MODIF = SYSDATETIME()
      WHERE ID = @id
    `)

  await auditarEn(
    e,
    id,
    `En observación: ${MOTIVO_FACTURA_NO_COINCIDE} — ${diferencias.length} diferencia(s)`,
  )
  return true
}

/** Extrae un comprobante y deja el resultado en la base. No lanza. */
export async function procesarUno({ id, ruta, tipoFactura }: Pendiente): Promise<void> {
  try {
    const pdf = await leerPdf(ruta)
    const r = await extraerDePdf(pdf, tipoFactura)

    if (!r.ok) {
      await conTransaccion((tx) => marcarFalloEn(tx, id, r.error))
      return
    }

    const valores = Object.fromEntries(
      Object.entries(r.extraccion.campos).map(([k, v]) => [k, v.valor]),
    )

    const { codProvee, yaExisteEnTango } = await conTransaccion(async (tx) => {
      const prom = await guardarExtraccionEn(tx, id, r.extraccion)
      // Despues de guardarExtraccionEn y no antes: esa funcion borra todos
      // los PHF_CAMPO del comprobante para reescribirlos, asi que el campo
      // tiene que volver a escribirse aca o el formulario abriria con el
      // tipo vacio pese a que el operador ya lo eligio al importar. No es
      // una correccion del operador -- la eligio el, pero por otra via --,
      // asi que no contamina CORREGIDO_POR_USUARIO.
      await guardarCampoEn(tx, id, 'tipoFactura', tipoFactura, { corregidoPorUsuario: false })

      // Las facturas de conceptos y las liquidaciones de tarjeta van todas
      // con la condicion de compra 2 ("CONTADO 1 DIA") -- decision del
      // usuario. Se escribe, no se preselecciona nada mas en la pantalla:
      // validarCondCompra mira el valor guardado, asi que un default que
      // viviera solo en el formulario dejaria el registro bloqueado igual.
      // El operador la cambia desde la lista si a este comprobante le toca
      // otra.
      if (tipoFactura === 'conceptos' || tipoFactura === 'tarjeta') {
        await guardarCampoEn(tx, id, 'condcompra', COND_COMPRA_CONCEPTOS, {
          corregidoPorUsuario: false,
        })
      }
      await desnormalizarBandejaEn(tx, id, r.extraccion)
      const cod = await resolverProveedorEn(tx, id, r.extraccion.campos.cuit?.valor ?? null)
      await resolverCondicionCompraEn(tx, id, cod, r.extraccion.campos.condpago?.valor ?? null)

      // Antes del bloque de tarjeta: `ajustarNetoConIvaEn` deriva el neto de
      // las lineas de IVA, asi que tiene que ver los slots ya acomodados. Que
      // una percepcion se sume a los slots de IVA no le mueve el neto --
      // `esIvaSobreLaBase` la deja afuera-- pero el orden correcto es que la
      // mudanza termine antes de que alguien lea de ahi.
      await mudarPercepcionIvaEn(tx, id, tipoFactura)

      // Solo articulos: si el "neto gravado" impreso es el de antes del
      // descuento general, lo reemplaza por la base real que confirma el IVA.
      await corregirNetoTrasDescuentoEn(tx, id, cod, tipoFactura)

      // Solo articulos y remitos: cuantos renglones vienen sin codigo y sin
      // una descripcion aprendida para este proveedor. Es lo que manda el
      // comprobante a la pestaña "A vincular". Va despues de resolver el
      // proveedor, porque lo aprendido es por proveedor.
      if (vaContraOc(tipoFactura)) {
        await aprenderLecturaEn(tx, id, cod)
        const aVincular = await recalcularAVincularEn(tx, id, cod)
        if (aVincular > 0) {
          await auditarEn(
            tx,
            id,
            `${aVincular} renglón(es) sin código de artículo: hay que vincular la descripción con un artículo de Tango`,
          )
        }
      }

      // La fecha de emision, en la forma canonica dd/mm/aaaa. Cada proveedor
      // la imprime como quiere ("16/9/2026", "30.07.2026") y la IA la copia
      // tal cual; si se puede leer, se guarda normalizada para que el
      // operador vea siempre lo mismo. Si no se puede leer se deja como vino,
      // que es lo que validarFecha va a señalar.
      const fechaLeida = r.extraccion.campos.fecha?.valor ?? null
      const fechaCanonica = normalizarFechaArg(fechaLeida)
      if (fechaCanonica !== null && fechaCanonica !== fechaLeida) {
        await guardarCampoEn(tx, id, 'fecha', fechaCanonica, { corregidoPorUsuario: false })
      }

      // La fecha con la que el comprobante entra a la contabilidad. Depende
      // de la de emision y del cierre de Tango, asi que va despues de
      // guardarExtraccionEn, que es quien escribe `fecha`.
      // Un remito no entra a la contabilidad: no tiene fecha contable.
      if (tipoFactura !== 'remito') await calcularFechaContableEn(tx, id, fechaCanonica ?? fechaLeida)

      // Va despues de resolverProveedorEn porque el punto de venta se
      // aprende por proveedor: sin `cod` no hay a quien preguntarle.
      if (tipoFactura === 'tarjeta') {
        await completarIdentificacionTarjetaEn(tx, id, cod)
        // Va despues de guardarExtraccionEn, que es quien escribe PHF_CARGO.
        const excluidos = await aplicarCargosAprendidosEn(tx, id, cod)
        const neto = await recalcularNetoDeCargosEn(tx, id)
        if (neto !== null) {
          const detalle =
            excluidos > 0 ? `, ${excluidos} excluido(s) por lo aprendido del proveedor` : ''
          await auditarEn(
            tx,
            id,
            `Neto gravado calculado sumando ${r.extraccion.cargos.length} cargo(s)${detalle}: ${neto.toFixed(2)}`,
          )
        }

        // Ultimo recurso: si lo sumado no cierra contra el IVA impreso --o
        // si no hubo cargos que sumar-- se deriva el neto del IVA.
        const ajuste = await ajustarNetoConIvaEn(tx, id, cod)
        if (ajuste.ajustado) {
          await auditarEn(
            tx,
            id,
            `Neto ajustado por cálculo inverso desde el IVA: ${ajuste.neto!.toFixed(2)} ` +
              `(lo que había sumaba ${(ajuste.sumaCargos ?? 0).toFixed(2)})`,
          )
        }
      }
      const conValor = Object.values(r.extraccion.campos).filter((c) => c.valor !== null).length
      await marcarLeidoEn(tx, id, prom, r.ms, r.modelo, conValor)

      // Si ya existe en Tango no hay nada mas que evaluar: ni concepto, ni
      // remitos, ni la segunda pasada de renglones de abajo -- por eso el
      // corte temprano, no solo el cambio de estado.
      const existe = await marcarExistenteEnTangoEn(tx, id, cod, { ...valores, tipoFactura })
      if (!existe) await observarSinConceptoEn(tx, id, tipoFactura, cod)
      return { codProvee: cod, yaExisteEnTango: existe }
    })

    if (yaExisteEnTango) return

    // Segunda pasada: los renglones. Va FUERA de la transaccion de arriba a
    // proposito -- es otro llamado a la API, de unos diez segundos, y
    // mantener una transaccion abierta mientras tanto dejaria tomados los
    // locks del comprobante todo ese rato sin ninguna necesidad.
    //
    // Solo aplica a facturas de articulos con remito resuelto: en conceptos
    // y tarjeta no hay renglones que cargar, y `lineasDeRemitos` devuelve
    // vacio sin consultar nada.
    const { lineas, origen, carga } = await lineasDeRemitos(tipoFactura, codProvee, valores)

    let facturados: RenglonFacturado[] = []
    let errorRenglones: string | null = null
    if (lineas.length > 0) {
      const segunda = await extraerRenglonesFacturados(pdf, lineas)
      if (segunda.ok) facturados = segunda.renglones
      else errorRenglones = segunda.error
    }

    await conTransaccion(async (tx) => {
      carga.renglones = await guardarRenglonesFacturadosEn(tx, id, facturados, origen, lineas)

      if (carga.renglones > 0) {
        await auditarEn(
          tx,
          id,
          `Renglones leídos de la factura y cotejados contra el remito — ${carga.renglones} línea(s)`,
        )
      }

      // Un remito que no se pudo usar es un problema anterior al cotejo:
      // sin remito no hay contra que cotejar, asi que ese mensaje gana.
      const observado = await observarRemitosEn(tx, id, carga)
      if (observado || lineas.length === 0) return

      if (errorRenglones !== null) {
        // La cabecera salio bien y los renglones no. No se marca el
        // comprobante en error -- se puede revisar igual --, pero el cotejo
        // no corrio y el operador tiene que saberlo.
        await auditarEn(tx, id, `No se pudieron leer los renglones: ${errorRenglones.slice(0, 200)}`)
        return
      }

      await observarDiferenciasEn(tx, id, cotejarRenglones(facturados, lineas))
    })
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    await conTransaccion((tx) => marcarFalloEn(tx, id, mensaje)).catch(() => {})
  }
}

let corriendo = false
let temporizador: ReturnType<typeof setInterval> | null = null

/**
 * Drena la cola por completo, no solo una tanda de CONCURRENCIA. Un lote de
 * importacion de hasta 50 archivos deja como maximo CONCURRENCIA en vuelo
 * por vez, pero el `for` vuelve a pedir mientras `tomarPendientesEn` siga
 * devolviendo filas -- si no, `despertarWorker()` solo alcanzaria para los
 * primeros CONCURRENCIA del lote y el resto quedaria esperando al proximo
 * intervalo o a un reproceso manual.
 *
 * El guard `corriendo` evita que dos llamados solapados (el intervalo y un
 * `despertarWorker()` de un import o reproceso) corran dos loops en
 * paralelo: el que ya esta corriendo va a recoger las filas nuevas en su
 * proxima vuelta del `for`, asi que el segundo llamado no hace falta.
 */
async function tanda(): Promise<void> {
  if (corriendo) return
  corriendo = true
  try {
    for (;;) {
      const pendientes = await tomarPendientesEn(await getPool(), CONCURRENCIA)
      if (pendientes.length === 0) break
      await Promise.all(pendientes.map(procesarUno))
    }
  } catch {
    // Si la base no responde, la proxima tanda reintenta.
  } finally {
    corriendo = false
  }
}

/**
 * Worker en proceso. Es suficiente para una app de red interna con un
 * operador. Si en algun momento hay mas de una instancia, `tomarPendientes`
 * necesita un lock para que dos no tomen el mismo comprobante.
 */
export function arrancarWorker(): void {
  if (temporizador) return
  temporizador = setInterval(() => void tanda(), INTERVALO_MS)
  void tanda()
}

/** Despierta al worker sin esperar al intervalo. Se llama al importar. */
export function despertarWorker(): void {
  void tanda()
}
