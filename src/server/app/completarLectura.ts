/**
 * Lo que la app completa o corrige sola apenas la IA termina de leer un
 * comprobante, antes de que lo vea el operador: proveedor por CUIT,
 * condición de compra aprendida, ajustes del neto, fecha contable,
 * percepciones, cargos aprendidos, identificación de tarjeta, y los
 * frenos (ya existe en Tango, proveedor sin concepto). Lo llama
 * `procesarUno` (cola.ts). Separado de cola.ts el 2026-11-03.
 */
import sql from 'mssql'
import { type Extraccion } from '../ia/extraccion'
import { buscarRemitoEnSta14, nCompRemito } from '../tango/remitosCompra'
import { buscarProveedoresPorCuit } from '../tango/proveedores'
import { buscarConceptoProveedor } from '../tango/conceptos'
import { normalizarCuit, parsearImporte, parsearImporteONulo, formatFecha } from '@/lib/formato'
import { analizaCampo, type TipoFactura } from '@/lib/tipoFactura'
import { planificarPercepcionIva } from '@/lib/percepcionIva'
import { MAX_SLOTS_IVA } from '@/lib/alicuotas'
import { MAX_SLOTS_VARIOS } from '@/lib/percepciones'
import { MOTIVO_SIN_CONCEPTO } from '@/lib/observacion'
import { guardarCampoEn, auditarEn, obtenerDetalleEn } from './detalle'
import { cargarAprendidosEn } from './aprendizajeImpuestos'
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
import { fechaContableDe } from '@/lib/fechaContable'
import { cierreContable } from '@/server/tango/parametros'
import { listarAlicuotasIva } from '@/server/tango/impuestos'

type Ejecutor = { request(): sql.Request }

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

  // Recorta al ancho de la columna para que el driver no rechace el
  // parametro y tumbe la importacion entera, pero deja constancia: el valor
  // completo sigue en PHF_CAMPO, y lo que se corta aca es lo que la bandeja
  // y el chequeo de duplicados por PUNTO_VENTA/NUMERO van a usar.
  const recortados: string[] = []
  const recortar = (clave: string, max: number): string | null => {
    const valor = v(clave)
    if (valor === null || valor.length <= max) return valor
    recortados.push(`${clave} (${valor.length} caracteres, se guardan ${max})`)
    return valor.slice(0, max)
  }

  await e
    .request()
    .input('id', sql.Int, id)
    .input('tipo', sql.VarChar(10), recortar('tipo', 10))
    .input('pv', sql.VarChar(10), recortar('ptovta', 10))
    .input('nro', sql.VarChar(20), recortar('nro', 20))
    .input('cuit', sql.VarChar(15), recortar('cuit', 15))
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

  if (recortados.length > 0) {
    await auditarEn(
      e,
      id,
      `La bandeja guardó recortado: ${recortados.join('; ')}. El valor leído completo está en el formulario; revisalo contra el PDF.`,
    )
  }
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
