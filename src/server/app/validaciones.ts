import sql from 'mssql'
import { getPool } from '../db/pool'
import { obtenerDetalleEn, type Detalle } from './detalle'
import { buscarProveedoresPorCuit, type Proveedor } from '@/server/tango/proveedores'
import { buscarFacturaEnCpa04 } from '@/server/tango/comprobantes'
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
  netoQueImplicaElIva,
  validarAlicuotas,
  type ResultadoValidacion,
} from '@/lib/validaciones'
import { conceptoDelComprobante, COD_CONCEPTO_TARJETA } from '@/server/tango/conceptos'
import { esCuitPropio } from './empresa'
import { listarCodigosImpuesto, listarAlicuotasIva } from '@/server/tango/impuestos'
import { resolverAlicuotas } from '@/lib/alicuotas'
import { resolverPercepciones, resolverVarios } from '@/lib/percepciones'
import { analizaCampo, tipoFacturaODefault } from '@/lib/tipoFactura'
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

  if (codProveeParaDuplicado) {
    const letra = letraComprobante(valores.tipo ?? '')
    const ptovta = valores.ptovta ?? ''
    const nro = valores.nro ?? ''

    if (letra && ptovta && nro) {
      const candidato = armarNComp(letra, ptovta, nro)

      const enTango = await buscarFacturaEnCpa04(codProveeParaDuplicado, candidato)
      if (enTango) {
        hayDuplicado = true
        referenciaDuplicado = `factura ${enTango.nComp} ya registrada en Tango`
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

  const condCompra = validarCondCompra(valores.condcompra)
  const percepcionIibb = validarPercepciones(
    resolverPercepciones(valores, valores.tipoFactura, aprendidosPercep),
  )
  const aprendidosVarios = await cargarAprendidosEn(e, codProvee, 'varios')
  const varios = validarVarios(
    resolverVarios(valores, await listarCodigosImpuesto(), aprendidosVarios),
  )
  const formatoComp = validarFormatoNComp(valores.ptovta, valores.nro)
  const fecha = validarFecha(valores.fecha)
  const tipoFactura = validarTipoFactura(valores.tipoFactura)

  // El concepto aplica en conceptos (sale de la ficha del proveedor) y en
  // tarjeta (es el fijo de comisiones). Las de articulos se imputan por
  // renglon: ahi no hay concepto y el item dice "No aplica".
  let concepto: ResultadoValidacion = { estado: 'ok', mensaje: 'No aplica.' }
  if (valores.tipoFactura === 'conceptos' || valores.tipoFactura === 'tarjeta') {
    const encontrado = await conceptoDelComprobante(valores.tipoFactura, codProvee || null)
    concepto = encontrado
      ? { estado: 'ok', mensaje: `Concepto: ${encontrado.codConcepto} — ${encontrado.descripcion}.` }
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
