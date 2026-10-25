import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, type Detalle } from './detalle'
import { buscarProveedoresPorCuit, type Proveedor } from '@/server/tango/proveedores'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
import { buscarRemitoEnSta14 } from '@/server/tango/remitosCompra'
import {
  letraComprobante,
  nComp as armarNComp,
  validarProveedor,
  validarDuplicado,
  validarTotales,
  validarCae,
  validarFormatoNComp,
  validarFecha,
  validarCondCompra,
  validarPercepciones,
  validarVarios,
  validarTipoFactura,
  validarNetoContraIva,
  validarCotejoOc,
  validarCantidadesOc,
  validarRenglonesContraNeto,
  validarPreciosContraOc,
  validarCodigosRepetidos,
  validarLeyenda,
  netoQueImplicaElIva,
  validarAlicuotas,
  type ResultadoValidacion,
} from '@/lib/validaciones'
import { conceptoDelComprobante, COD_CONCEPTO_TARJETA } from '@/server/tango/conceptos'
import { esCuitPropio } from './empresa'
import { listarCodigosImpuesto, listarAlicuotasIva } from '@/server/tango/impuestos'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { cotejarConOc, type ResultadoCotejoOc } from '@/lib/cotejoOc'
import { parsearImporte, parsearImporteONulo } from '@/lib/formato'
import { resolverDescuentoDeDetalle, netosPorOrden } from '@/lib/descuentoGlobal'
import { articulosPorSinonimo } from '@/server/tango/articulos'
import { lineasPdfResueltasEn } from './ordenCompra'
import { lineasContraOc, abrirPorTalle } from '@/lib/matchOc'
import { reglaDeProveedorEn } from './lecturaProveedor'
import { analizaCampo, tipoFacturaODefault, vaContraOc } from '@/lib/tipoFactura'
import { cargarAprendidosEn } from './aprendizajeImpuestos'

type Ejecutor = { request(): sql.Request }

export type Validaciones = {
  proveedor: ResultadoValidacion
  duplicado: ResultadoValidacion
  totales: ResultadoValidacion
  /**
   * `null` cuando el tipo de comprobante no analiza el CAE. Sin el dato no
   * hay nada que validar, y un item permanente en amarillo diciendo "CAE
   * con formato invalido" en cada factura de conceptos entrena al operador
   * a ignorar el panel entero.
   */
  cae: ResultadoValidacion | null
  candidatosProveedor: Proveedor[]
  bloqueante: boolean
}

/**
 * `detallePrevio` evita un segundo round-trip a PHF_CAMPO/PHF_RENGLON/
 * PHF_AUDITORIA cuando quien llama (la pantalla de revisión) ya lo leyó
 * para renderizar el formulario. Si no se pasa, se lee acá como antes --
 * `confirmarComprobante`, por ejemplo, no tiene un detalle a mano.
 */
export async function validarComprobanteEn(
  e: Ejecutor,
  id: number,
  detallePrevio?: Detalle,
): Promise<Validaciones> {
  const detalle = detallePrevio ?? (await obtenerDetalleEn(e, id))
  const valores: Record<string, string | null> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal

  const cuit = valores.cuit ?? ''
  const candidatosProveedor = cuit ? await buscarProveedoresPorCuit(cuit) : []

  // `codprovee` gana sobre el CUIT: lo escribe `elegirProveedorEn` cuando el
  // operador resuelve a mano un CUIT sin match o con 2+ matches, y tambien
  // `resolverProveedorEn` cuando el CUIT matchea a uno solo. Si se siguiera
  // revalidando solo contra `candidatosProveedor.length`, un CUIT duplicado
  // (2+ matches) quedaria bloqueante para siempre aunque el operador ya
  // hubiera elegido: `validarProveedor` volveria a contar los mismos 2+
  // matches del CUIT en vez de mirar la eleccion ya hecha.
  const codProveeElegido = valores.codprovee?.trim() || null
  let proveedor = codProveeElegido ? validarProveedor(1) : validarProveedor(candidatosProveedor.length)

  // Segunda barrera contra confundir emisor con receptor. La primera es el
  // prompt (ver quienEsElProveedor); esta agarra el caso en que el modelo
  // igual lo lea mal. Va despues de resolver el proveedor para que pise el
  // mensaje: un CUIT propio bien podria matchear un proveedor de CPA01 --
  // la empresa puede estar cargada como proveedora de si misma -- y
  // entonces esto se veria como "Proveedor resuelto." sin serlo.
  if (esCuitPropio(valores.cuit)) {
    proveedor = {
      estado: 'error',
      mensaje:
        'El CUIT leído es el de la propia empresa: la IA tomó los datos del cliente ' +
        'en vez de los del proveedor. Corregí razón social y CUIT con los del emisor.',
    }
  }

  // Codigo de proveedor a usar para el chequeo de duplicados: el elegido a
  // mano si existe, si no el unico candidato por CUIT (si hay exactamente
  // uno). Con 0 o 2+ candidatos y sin eleccion manual no hay con que
  // consultar CPA04 -- el chequeo no corre, y eso se refleja como
  // "advertencia", no como un falso "ok".
  const codProveeParaDuplicado =
    codProveeElegido ?? (candidatosProveedor.length === 1 ? candidatosProveedor[0].codProvee : null)

  let hayDuplicado = false
  let referenciaDuplicado: string | null = null
  let duplicadoNoVerificado: string | null = null

  const esRemito = valores.tipoFactura === 'remito'

  if (codProveeParaDuplicado) {
    // Un remito no lleva letra: su numero se arma siempre con R y se busca en
    // Stock (STA14), no en Compras.
    const letra = esRemito ? 'R' : letraComprobante(valores.tipo ?? '')
    const ptovta = valores.ptovta ?? ''
    const nro = valores.nro ?? ''

    if (letra && ptovta && nro) {
      const candidato = armarNComp(letra, ptovta, nro)

      const enTango = esRemito
        ? await buscarRemitoEnSta14(codProveeParaDuplicado, candidato)
        : await buscarFacturaEnCpa04(codProveeParaDuplicado, candidato)
      if (enTango) {
        hayDuplicado = true
        referenciaDuplicado = esRemito
          ? `remito ${enTango.nComp} ya registrado en Tango`
          : `factura ${enTango.nComp} ya registrada en Tango`
      } else {
        const enApp = await e
          .request()
          .input('id', sql.Int, id)
          .input('cp', sql.VarChar(20), codProveeParaDuplicado)
          .input('tipo', sql.VarChar(10), valores.tipo?.slice(0, 10) ?? null)
          .input('pv', sql.VarChar(10), ptovta)
          .input('nro', sql.VarChar(20), nro)
          .query(`
            SELECT TOP 1 ID FROM PHF_COMPROBANTE
            WHERE ID <> @id AND COD_PROVEE = @cp AND TIPO = @tipo
              AND PUNTO_VENTA = @pv AND NUMERO = @nro
          `)
        if (enApp.recordset.length > 0) {
          hayDuplicado = true
          referenciaDuplicado = `comprobante interno ${enApp.recordset[0].ID}`
        }
      }
    } else {
      duplicadoNoVerificado = 'No se pudo verificar duplicados: falta tipo, punto de venta o número.'
    }
  } else {
    duplicadoNoVerificado = 'No se pudo verificar duplicados: falta resolver el proveedor.'
  }

  const duplicado: ResultadoValidacion = duplicadoNoVerificado
    ? { estado: 'advertencia', mensaje: duplicadoNoVerificado }
    : validarDuplicado(hayDuplicado, referenciaDuplicado)
  const tipoFactura = tipoFacturaODefault(valores.tipoFactura)
  const totales = validarTotales(valores, tipoFactura)
  const cae = analizaCampo(tipoFactura, 'cae')
    ? validarCae(valores.cae, valores.vtocae, new Date())
    : null

  return {
    proveedor,
    duplicado,
    totales,
    cae,
    candidatosProveedor,
    bloqueante: proveedor.estado === 'error' || duplicado.estado === 'error',
  }
}

export async function validarComprobante(id: number, detallePrevio?: Detalle): Promise<Validaciones> {
  return validarComprobanteEn(await getPool(), id, detallePrevio)
}

export type ResultadoListoParaRegistrar = {
  condCompra: ResultadoValidacion
  percepcionIibb: ResultadoValidacion
  formatoComp: ResultadoValidacion
  fecha: ResultadoValidacion
  tipoFactura: ResultadoValidacion
  concepto: ResultadoValidacion
  alicuotas: ResultadoValidacion
  varios: ResultadoValidacion
  netoIva: ResultadoValidacion
  /** Cotejo contra la orden de compra imputada. Solo aplica en articulos. */
  ordenCompra: ResultadoValidacion
  /** Que ningún renglón facture más de lo que la orden tiene pendiente. */
  cantidadesOc: ResultadoValidacion
  /**
   * Que lo que la factura cobra por renglón cierre contra su neto gravado,
   * resolviendo el descuento global del pie. Bloquea. Ver descuentoGlobal.ts.
   */
  renglonesNeto: ResultadoValidacion
  /** Precio de la factura contra el de la OC. Advierte: la factura manda. */
  preciosOc: ResultadoValidacion
  /**
   * Qué líneas terminan sumadas por caer en el mismo código de Tango. Avisa,
   * no bloquea: el registro las suma solo -- decisión del usuario, 2026-09-08.
   */
  codigosRepetidos: ResultadoValidacion
  /** Que la observación entre entera en CPA04.LEYENDA, que es varchar(30). */
  leyenda: ResultadoValidacion
  /**
   * El neto que implican las líneas de IVA, para ofrecérselo al operador de
   * un clic cuando `netoIva` no cierra. `null` si no hay ninguna línea que
   * permita deducirlo.
   */
  netoSegunIva: number | null
  bloqueante: boolean
}

/**
 * Gate de la transicion confirmado -> registrado, distinto del de Fase 3
 * (leido/observacion -> confirmado). Las 4 validaciones de Fase 3 ya
 * bloquearon esa primera transicion y se vuelven a chequear server-side
 * dentro de la propia transaccion de registro -- no se repiten aca.
 */
export async function validarListoParaRegistrarEn(
  e: Ejecutor,
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  const detalle = detallePrevio ?? (await obtenerDetalleEn(e, id))
  const valores: Record<string, string | null | undefined> = {}
  for (const c of detalle.campos) valores[c.clave] = c.valorFinal
  const codProvee = (valores.codprovee ?? '').trim()

  // Lo que este proveedor ya le enseñó a la app para IVA e IIBB (ver
  // aprendizajeImpuestos.ts): se consulta acá para que "listo para
  // registrar" no pueda decir bloqueante algo que el registro real (que
  // usa la misma fuente) va a resolver solo.
  //
  // Secuencial y no Promise.all: `e` puede ser una sql.Transaction, y dos
  // pedidos en vuelo sobre la misma cuelgan la conexión en vez de fallar
  // -- ver el mismo comentario en asiento.ts, donde se reprodujo el
  // cuelgue corriendo la suite de tests.
  const aprendidosIva = await cargarAprendidosEn(e, codProvee, 'iva')
  const aprendidosPercep = await cargarAprendidosEn(e, codProvee, 'percepcion')

  const esRemito = valores.tipoFactura === 'remito'
  // Un remito no tiene condicion de compra: no genera deuda, la genera la
  // factura que lo consume.
  const condCompra: ResultadoValidacion = esRemito
    ? { estado: 'ok', mensaje: 'No aplica: un remito no tiene condición de compra.' }
    : validarCondCompra(valores.condcompra)
  const codigosImpuesto = await listarCodigosImpuesto()
  const lineasPercep = resolverPercepciones(
    valores,
    valores.tipoFactura,
    aprendidosPercep,
    codigosImpuesto,
  )
  const percepcionIibb = validarPercepciones(lineasPercep)
  const aprendidosVarios = await cargarAprendidosEn(e, codProvee, 'varios')
  const lineasVarios = resolverVarios(valores, codigosImpuesto, aprendidosVarios)
  const varios = validarVarios(lineasVarios)
  const formatoComp = validarFormatoNComp(valores.ptovta, valores.nro)
  const fecha = validarFecha(valores.fecha)
  const tipoFactura = validarTipoFactura(valores.tipoFactura)

  // Cotejo contra la orden de compra imputada (solo articulos). Los
  // renglones con OC son lo que se va a facturar y `renglonesPdf` es lo que
  // dice el papel; si no coinciden, bloquea.
  //
  // Los sinonimos se piden solo si hay algo que cotejar: es una consulta a
  // CPA15 que en conceptos y tarjeta no tendria a quien servir.
  const conOc = detalle.renglones.filter((r) => r.ocNOrdenCo)
  let cotejoOc: ResultadoCotejoOc | null = null
  if (vaContraOc(valores.tipoFactura) && conOc.length > 0) {
    // Con el codigo aprendido por descripcion ya aplicado: un renglon que el
    // operador vinculo tiene que cotejar igual que uno con codigo impreso.
    // Los cargos del proveedor no se cotejan contra la orden: no van contra
    // ninguna (2026-09-22, pedido del usuario). Ver SIN_OC en migrate.ts.
    // Abierto por talle contra los articulos ya imputados: si la factura
    // desglosa (TOPPER), lo que se coteja son los renglones por talle, que
    // es lo que se va a registrar. Sin esto las tres lineas impresas se
    // marcarian como "no esta en la orden de compra".
    const lineas = lineasContraOc(
      abrirPorTalle(
        await lineasPdfResueltasEn(e, detalle, codProvee),
        conOc.map((r) => (r.codigoFinal ?? r.codigo ?? '').trim()),
        (await reglaDeProveedorEn(e, codProvee))?.escala === 'desglose-talle',
      ),
    )
    const codigos = lineas
      .map((r) => (r.codigo ?? '').trim())
      .filter((c) => c !== '')
    // `articulosPorSinonimo` y no `sinonimosDelProveedor`: lo que se tiene es
    // el codigo IMPRESO y hay que averiguar que articulo es. Hasta el
    // 2026-09-07 aca se pedia el mapa al reves y se lo daba vuelta despues,
    // pero ese filtra por codigo NUESTRO y lo que se le pasaba eran los
    // impresos: no matcheaba ninguno y el mapa volvia vacio, asi que la
    // traduccion por sinonimo nunca llegaba a aplicarse.
    const alNuestro = codProvee
      ? await articulosPorSinonimo(codProvee, codigos)
      : new Map<string, string>()

    cotejoOc = cotejarConOc(
      lineas.map((r) => ({ orden: r.orden, codigo: r.codigo, cantidad: r.cantidad })),
      conOc.map((r) => ({
        nRenglOc: r.ocNRenglOc!,
        codArticu: (r.codigoFinal ?? r.codigo ?? '').trim(),
        descripcion: r.descripcion ?? '',
        pendiente: Number(r.ocPendiente ?? 0),
      })),
      alNuestro,
    )
  }
  const ordenCompra = validarCotejoOc(valores.tipoFactura, conOc.length > 0, cotejoOc)

  // Contra las cantidades del RENGLON, que son las que se van a registrar --
  // el cotejo de arriba mira las que leyo la IA del PDF, y dejan de ser lo
  // mismo en cuanto el operador corrige una a mano.
  const cantidadesOc = validarCantidadesOc(
    valores.tipoFactura,
    conOc.map((r) => ({
      codigo: r.codigoFinal ?? r.codigo,
      cantidad: parsearImporte(r.cantidad),
      pendiente: r.ocPendiente === null ? null : Number(r.ocPendiente),
    })),
  )

  // El concepto aplica en conceptos (sale de la ficha del proveedor) y en
  // tarjeta (es el fijo de comisiones). Las de articulos se imputan por
  // renglon: ahi no hay concepto y el item dice "No aplica".
  let concepto: ResultadoValidacion = { estado: 'ok', mensaje: 'No aplica.' }
  if (valores.tipoFactura === 'conceptos' || valores.tipoFactura === 'tarjeta') {
    const elegido = (valores.concepto ?? '').trim()
    const encontrado = await conceptoDelComprobante(valores.tipoFactura, codProvee || null, elegido)
    // Si el operador eligio un concepto para este comprobante, se dice cual
    // tiene la ficha del proveedor: la eleccion no la cambia, y conviene que
    // se vea que son dos cosas distintas.
    const delProveedor =
      elegido && valores.tipoFactura === 'conceptos' && codProvee
        ? await conceptoDelComprobante('conceptos', codProvee, null)
        : null
    const aclaracion = elegido
      ? delProveedor && delProveedor.codConcepto !== encontrado?.codConcepto
        ? ` Elegido para este comprobante; la ficha del proveedor tiene ${delProveedor.codConcepto} — ${delProveedor.descripcion} y no se modifica.`
        : ' Elegido para este comprobante.'
      : ''
    concepto = encontrado
      ? { estado: 'ok', mensaje: `Concepto: ${encontrado.codConcepto} — ${encontrado.descripcion}.${aclaracion}` }
      : elegido
        ? { estado: 'error', mensaje: `El concepto ${elegido} elegido para este comprobante no existe en Tango.` }
        : {
          estado: 'error',
          mensaje:
            valores.tipoFactura === 'tarjeta'
              ? `El concepto ${COD_CONCEPTO_TARJETA} de comisiones de tarjeta no existe en Tango.`
              : 'Este proveedor no tiene un concepto configurado en Tango.',
        }
  }

  // Resuelve cada par porcivaN/impivaN contra CPA14 con la misma funcion
  // que usa el armado real de la cabecera, asi el operador ve en la
  // revision a que alicuota de Tango va cada linea -- y si alguna no
  // existe, se entera antes de apretar "Registrar en Tango" y no despues.
  const lineasIva = resolverAlicuotas(valores, await listarAlicuotasIva(), aprendidosIva)
  const alicuotas = validarAlicuotas(lineasIva)

  // Cotejo del neto contra el IVA impreso. En tarjeta es bloqueante: ahi el
  // neto no viene impreso, se compone sumando cargos, y un componente
  // faltante se arrastra al total, a las cuotas y al asiento entero.
  const netoIva = validarNetoContraIva(lineasIva, valores.neto, valores.tipoFactura)
  const netoSegunIva = netoQueImplicaElIva(lineasIva)

  // Lo que la factura cobra por renglon, contra su base gravada. Decide con
  // el IVA de arriba si los subtotales son netos o brutos. Es la
  // misma resolucion que despues usa el armado de CPA46: el precio que se
  // graba es el neto derivado del subtotal impreso, no el de la OC
  // (decision del usuario, 2026-09-15). Bloquea si no cierra.
  const descuento =
    valores.tipoFactura === 'articulos' && detalle.renglonesPdf.length > 0
      ? resolverDescuentoDeDetalle(
          detalle.renglonesPdf,
          valores.descuentogeneral,
          valores.neto,
          netoSegunIva,
        )
      : null
  const renglonesNeto = validarRenglonesContraNeto(valores.tipoFactura, descuento)

  // Y el precio de la factura contra el pactado en la OC: advierte, no
  // bloquea -- la factura manda y la orden es la referencia.
  const netos = descuento ? netosPorOrden(descuento) : new Map()
  const preciosOc = validarPreciosContraOc(
    valores.tipoFactura,
    conOc.map((r) => ({
      codigo: r.codigoFinal ?? r.codigo,
      precioFactura: r.pdfOrden === null ? null : (netos.get(r.pdfOrden)?.precioNeto ?? null),
      precioOc: parsearImporteONulo(r.precioUnitario),
    })),
  )

  // Va despues de resolver las tres familias porque las mira a las tres
  // juntas: CPA18 no admite dos veces el mismo codigo, y ahi caen tanto las
  // percepciones de IIBB como los impuestos varios.
  const codigosRepetidos = validarCodigosRepetidos(lineasIva, lineasPercep, lineasVarios)

  // La observacion va a CPA04.LEYENDA, que es varchar(30): si no entra
  // entera conviene verlo antes de registrar y no despues, en Tango.
  const leyenda = validarLeyenda(valores.leyendaAsiento)

  // Un remito sin renglones no tiene nada que entrar a stock, y uno sin
  // articulo no se puede grabar en STA20. En una factura de articulos lo
  // mismo lo cubren el cotejo contra la orden y los renglones contra el neto;
  // el remito no tiene neto, asi que se pide aca.
  const sinArticulo = detalle.renglones.filter((r) => !(r.codigoFinal ?? r.codigo ?? '').trim())
  const renglonesRemito: ResultadoValidacion | null = !esRemito
    ? null
    : detalle.renglones.length === 0
      ? { estado: 'error', mensaje: 'El remito no tiene renglones para registrar: imputale la orden de compra.' }
      : sinArticulo.length > 0
        ? { estado: 'error', mensaje: `Hay ${sinArticulo.length} renglón(es) sin artículo de Tango.` }
        : {
            estado: 'ok',
            mensaje: `${detalle.renglones.length} renglón(es) entran al depósito 01.`,
          }

  const bloqueante = [
    condCompra,
    percepcionIibb,
    varios,
    formatoComp,
    fecha,
    tipoFactura,
    concepto,
    alicuotas,
    netoIva,
    ordenCompra,
    cantidadesOc,
    renglonesNeto,
    ...(renglonesRemito ? [renglonesRemito] : []),
  ].some((v) => v.estado === 'error')

  return {
    condCompra,
    percepcionIibb,
    varios,
    formatoComp,
    fecha,
    tipoFactura,
    concepto,
    alicuotas,
    netoIva,
    // En un remito, el item de renglones ocupa el lugar del de importes: es
    // lo unico que tiene para cerrar.
    ordenCompra,
    cantidadesOc,
    renglonesNeto: renglonesRemito ?? renglonesNeto,
    preciosOc,
    codigosRepetidos,
    leyenda,
    netoSegunIva,
    bloqueante,
  }
}

export async function validarListoParaRegistrar(
  id: number,
  detallePrevio?: Detalle,
): Promise<ResultadoListoParaRegistrar> {
  return validarListoParaRegistrarEn(await getPool(), id, detallePrevio)
}
