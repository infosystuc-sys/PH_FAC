import { totalImputado, parsearImporte } from './formato'
import { formatPorcentaje, esIvaSobreLaBase, type LineaAlicuota } from './alicuotas'
import type { LineaPercepcion, LineaVarios } from './percepciones'
import { describirCotejo, type ResultadoCotejoOc } from './cotejoOc'
import { describirDescuento, type ResultadoDescuento } from './descuentoGlobal'
import { LARGO_LEYENDA_COMPROBANTE } from './campos'

export { LARGO_LEYENDA_COMPROBANTE }

export type ResultadoValidacion = {
  estado: 'ok' | 'advertencia' | 'error'
  mensaje: string
}

const LETRAS_VALIDAS = ['A', 'B', 'C', 'E', 'M', 'T']
const RE_LETRA = /\b([ABCEMT])\b/i

/**
 * El campo `tipo` lo devuelve la IA en texto libre ("FAC A", "FACTURA A
 * 0011-00063576", "C"...) porque el prompt no le fuerza un formato exacto.
 * Se busca una letra de comprobante valida como palabra suelta en vez de
 * asumir que siempre esta al final o al principio.
 */
export function letraComprobante(tipo: string): string | null {
  const m = RE_LETRA.exec(tipo.toUpperCase())
  return m && LETRAS_VALIDAS.includes(m[1]) ? m[1] : null
}

/**
 * Le saca al numero (o al punto de venta) los ceros de relleno de la
 * izquierda, dejando al menos un digito.
 *
 * Hace falta porque hay comprobantes que imprimen el numero rellenado a mas
 * digitos de los que Tango guarda: los resumenes de Banco Macro, BBVA,
 * Galicia y Ciudad lo traen a 12 ("000020984549"), y CPA04 lo almacena a 8.
 * Sin esto, esos 13 comprobantes quedaban bloqueados por "el numero tiene
 * 12 digitos, el maximo son 8" pese a que el numero entra perfecto: es
 * relleno, no dato.
 *
 * Es reversible: `nComp` vuelve a rellenar a 8, asi que el N_COMP final es
 * identico al que Tango guarda. Y no esconde un numero que de verdad no
 * entra -- si despues de sacar los ceros quedan mas de 8 digitos,
 * `validarFormatoNComp` lo sigue rechazando.
 */
export function sinCerosDeRelleno(valor: string): string {
  return valor.trim().replace(/^0+(?=\d)/, '')
}

/**
 * Reconstruye el N_COMP tal como Tango lo guarda en CPA04: letra + punto
 * de venta a 5 digitos + numero a 8 digitos (verificado contra 5 años de
 * facturas reales de un mismo proveedor, ver plan Task 2).
 *
 * Los ceros de relleno de mas se sacan antes de repadear (ver
 * `sinCerosDeRelleno`), con la misma funcion que usa
 * `validarFormatoNComp`: si las dos no coincidieran, la pantalla podria
 * decir "listo" y el registro armar un numero distinto. Lo que sigue sin
 * truncarse es un dato genuinamente mas largo que el padding -- eso tiene
 * que fallar el match, no esconderse.
 */
export function nComp(letra: string, ptovta: string, nro: string): string {
  const pv = sinCerosDeRelleno(ptovta).padStart(5, '0')
  const n = sinCerosDeRelleno(nro).padStart(8, '0')
  return `${letra}${pv}${n}`
}

export function validarProveedor(cantidadMatches: number): ResultadoValidacion {
  if (cantidadMatches === 1) return { estado: 'ok', mensaje: 'Proveedor resuelto.' }
  if (cantidadMatches === 0) {
    return { estado: 'error', mensaje: 'Sin coincidencia por CUIT. Elegí el proveedor manualmente.' }
  }
  return {
    estado: 'error',
    mensaje: `Hay ${cantidadMatches} proveedores con este CUIT. Elegí cuál corresponde.`,
  }
}

export function validarDuplicado(hayDuplicado: boolean, referencia: string | null): ResultadoValidacion {
  if (!hayDuplicado) return { estado: 'ok', mensaje: 'Sin duplicados.' }
  return {
    estado: 'error',
    mensaje: `Ya existe un comprobante igual: ${referencia ?? 'referencia no disponible'}.`,
  }
}

const TOLERANCIA_CENTAVOS = 0.01

/**
 * En una liquidación de tarjeta el "total" impreso en el resumen sale por
 * diferencia -- arrastra saldo anterior, pagos y otros movimientos que la
 * app no captura -- así que no sirve como total del comprobante. Se
 * registra siempre el subtotal (el monto del concepto) más IVA más
 * impuestos, calculado por `totalImputado`. Esta validación nunca compara
 * contra `valores.total` en tarjeta: lo dice en vez de advertir sobre una
 * diferencia esperada. Mismo criterio y misma función usa
 * `registrarComprobanteEn` (`src/server/tango/comprobantes.ts`) y
 * `previsualizarAsientoEn` (`src/server/tango/asiento.ts`) para el importe
 * que de verdad se graba, así que este mensaje nunca puede divergir de lo
 * que termina en Tango.
 */
export function validarTotales(
  valores: Record<string, string | null | undefined>,
  tipoFactura?: string | null,
): ResultadoValidacion {
  const imputado = totalImputado(valores)
  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  if (tipoFactura === 'tarjeta') {
    return {
      estado: 'ok',
      mensaje:
        `Total del comprobante: $ ${fmt.format(imputado)} (subtotal + IVA + impuestos -- ` +
        `no el importe leído del resumen, que sale por diferencia).`,
    }
  }

  const total = parsearImporte(valores.total)
  const diferencia = Math.abs(imputado - total)
  if (diferencia <= TOLERANCIA_CENTAVOS) {
    return { estado: 'ok', mensaje: 'Los importes cierran contra el total.' }
  }
  return {
    estado: 'advertencia',
    mensaje: `La suma de los importes difiere en $ ${fmt.format(diferencia)} del total leído.`,
  }
}

/**
 * Cuanto puede diferir el neto declarado del que implica el IVA impreso
 * antes de considerarlo un error. Es relativa y no de centavos a proposito:
 * las liquidaciones reales calculan el IVA por transaccion y despues suman,
 * asi que el redondeo se acumula -- en el resumen de Banco Macro el IVA
 * impreso difiere 13 centavos del 21% exacto del neto impreso, sobre
 * $182.759, y esta bien. Un componente faltante, que es lo que esta
 * validacion busca, nunca es el 0,5%: en el caso real que la motivo era el
 * 50% del neto.
 */
const TOLERANCIA_NETO_IVA = 0.005
const TOLERANCIA_NETO_IVA_MINIMA = 1

/**
 * Coteja el neto gravado contra el que implica el IVA impreso: si una
 * factura declara $914,74 de IVA al 21%, su base tiene que ser $4.355,90.
 *
 * Existe por un problema real de las liquidaciones de tarjeta: ahi el neto
 * gravado no viene impreso en ningun renglon, es la SUMA de varios cargos
 * (arancel, comision, costo financiero, cargo de transferencia...) que cada
 * procesadora rotula distinto, y encima todas traen alguna linea que parece
 * la respuesta y no lo es -- el resumen de Tarjeta Sol tiene un renglon
 * literalmente llamado "Importe neto" que es lo acreditado, no la base.
 * Leyendo el mismo PDF dos veces, la IA devolvio dos bases distintas
 * (4.355,94 y 2.177,97, o sea un componente de menos) y en la equivocada
 * subio la confianza de 0,55 a 0,88: la confianza no sirve como alarma.
 *
 * El IVA si es un dato firme -- viene impreso, rotulado y sin ambiguedad --
 * asi que sirve de verificador independiente del dato que no lo es.
 */
/**
 * La base gravada que implican las líneas de IVA, o `null` si ninguna sirve
 * para deducirla. Separada de la validación porque el número también se le
 * ofrece al operador para que lo aplique de un clic cuando el cotejo falla.
 */
export function netoQueImplicaElIva(lineas: LineaAlicuota[]): number | null {
  let base = 0
  let cuantas = 0
  for (const l of lineas) {
    // Solo el IVA que grava la base. Una percepcion o una retencion viven
    // en estos mismos slots (ver esIvaSobreLaBase) y su importe dividido por
    // su porcentaje no es base gravada: sumarlas inventaria neto. Es lo que
    // le permite al operador destrabar el caso real que motivo esto --
    // corrige a mano el codigo de la linea mal leida y el cotejo cierra.
    if (!esIvaSobreLaBase(l.alicuota)) continue
    // El 0% no dice nada de la base, y ademas dividiria por cero.
    if (l.porcentaje <= 0 || l.importe <= 0) continue
    base += l.importe / (l.porcentaje / 100)
    cuantas += 1
  }
  return cuantas === 0 ? null : Math.round(base * 100) / 100
}

/**
 * Si un neto puede considerarse el que implica el IVA. Compartida entre la
 * validación y el ajuste automático de tarjeta (`ajustarNetoConIvaEn`) para
 * que no puedan discrepar: sería absurdo que el pipeline diera por bueno un
 * neto que la pantalla marca en rojo, o al revés.
 */
export function netoCierraConIva(esperado: number, neto: number): boolean {
  const tolerancia = Math.max(TOLERANCIA_NETO_IVA_MINIMA, esperado * TOLERANCIA_NETO_IVA)
  return Math.abs(esperado - neto) <= tolerancia
}

export function validarNetoContraIva(
  lineas: LineaAlicuota[],
  netoDeclarado: string | null | undefined,
  tipoFactura?: string | null,
): ResultadoValidacion {
  const esperado = netoQueImplicaElIva(lineas)

  if (esperado === null) {
    return { estado: 'ok', mensaje: 'Sin líneas de IVA para cotejar contra el neto.' }
  }

  const fmt = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const neto = parsearImporte(netoDeclarado)
  const diferencia = Math.abs(esperado - neto)

  if (netoCierraConIva(esperado, neto)) {
    return { estado: 'ok', mensaje: `El neto cierra con el IVA declarado ($ ${fmt.format(esperado)}).` }
  }

  return {
    // Bloqueante solo en tarjeta, que es donde el neto no viene impreso y
    // hay que componerlo: ahi una diferencia es casi siempre un cargo que
    // falta, y el neto arrastra al total y al asiento entero. En los otros
    // tipos el neto SI viene impreso, asi que una diferencia es mas probable
    // que sea un caso legitimo (una linea que el proveedor no desglosa) que
    // un error -- se avisa, no se frena.
    estado: tipoFactura === 'tarjeta' ? 'error' : 'advertencia',
    // No se le echa la culpa al neto: el desvío puede estar de cualquiera de
    // los dos lados, y decidirlo es del operador. En el caso real que
    // motivó esto pasaron las dos cosas -- en una liquidación faltaba un
    // cargo en el neto, y en otra el que estaba mal era el IVA (una
    // percepción del 3% leída como alícuota del 21%).
    mensaje:
      `El neto y el IVA no cierran: las alícuotas implican un neto de ` +
      `$ ${fmt.format(esperado)} y está declarado $ ${fmt.format(neto)} ` +
      `(difieren $ ${fmt.format(diferencia)}). Revisá si al neto le falta un cargo ` +
      `o si alguna línea de IVA tiene mal el porcentaje.`,
  }
}

/**
 * El cotejo de una factura de artículos contra su orden de compra.
 *
 * Bloquea siempre que haya una diferencia -- decisión del usuario,
 * 2026-09-06. A diferencia del cotejo contra el remito, que mandaba a
 * observación, acá la OC es un compromiso previo: si la factura cobra algo
 * que no se pidió, o más de lo que queda por facturar, no es algo que se
 * arregle releyendo el papel.
 *
 * Sin OC imputada también bloquea: toda factura de artículos se imputa a
 * una, así que no tenerla no es un caso válido sino un paso que falta.
 */
export function validarCotejoOc(
  tipoFactura: string | null | undefined,
  tieneOc: boolean,
  cotejo: ResultadoCotejoOc | null,
): ResultadoValidacion {
  if (tipoFactura !== 'articulos') {
    return { estado: 'ok', mensaje: 'No aplica: solo las facturas de artículos se imputan a una orden de compra.' }
  }
  if (!tieneOc) {
    return { estado: 'error', mensaje: 'Falta imputar la factura a una orden de compra.' }
  }
  if (!cotejo || cotejo.problemas.length === 0) {
    const sinFacturar = cotejo?.noFacturados.length ?? 0
    return {
      estado: 'ok',
      mensaje:
        sinFacturar > 0
          ? `La factura coincide con la orden de compra. Quedan ${sinFacturar} renglón(es) sin facturar en la orden.`
          : 'La factura coincide con la orden de compra.',
    }
  }
  return {
    estado: 'error',
    mensaje: `La factura no coincide con la orden de compra: ${describirCotejo(cotejo)}.`,
  }
}

/**
 * Que ningún renglón facture más de lo que la orden de compra tiene
 * disponible -- pedido del usuario, 2026-09-07.
 *
 * `validarCotejoOc` ya compara contra el pendiente, pero mira las cantidades
 * que la IA leyó del PDF. Esta mira las del renglón que se va a registrar,
 * que es otra cosa en cuanto el operador corrige una a mano: subirla dejaba
 * la pantalla en verde y el error aparecía recién al apretar "Registrar en
 * Tango", con la transacción ya abierta.
 *
 * `registrarComprobanteEn` vuelve a chequearlo contra el pendiente releído
 * dentro de la transacción, y ese sigue siendo el que manda: entre la
 * revisión y el registro, otra factura pudo haber consumido saldo. Este es
 * para que el operador se entere antes.
 *
 * La tolerancia es la misma que usa el cotejo: las cantidades salen de
 * parsear texto y `CPA36` es DECIMAL(22,7).
 */
const TOLERANCIA_CANTIDAD = 0.00005

export type RenglonContraOc = {
  codigo: string | null
  cantidad: number
  /** Lo que la OC tenía pendiente al imputarla (`PHF_RENGLON.OC_PENDIENTE`). */
  pendiente: number | null
}

export function validarCantidadesOc(
  tipoFactura: string | null | undefined,
  renglones: RenglonContraOc[],
): ResultadoValidacion {
  if (tipoFactura !== 'articulos') {
    return { estado: 'ok', mensaje: 'No aplica: solo las facturas de artículos se imputan a una orden de compra.' }
  }

  const fmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 })
  const excedidos = renglones.filter(
    (r) => r.pendiente !== null && r.cantidad - r.pendiente > TOLERANCIA_CANTIDAD,
  )
  if (excedidos.length === 0) {
    return { estado: 'ok', mensaje: 'Las cantidades entran en lo que la orden tiene pendiente.' }
  }

  const detalle = excedidos
    .map(
      (r) =>
        `${(r.codigo ?? '').trim() || 'un renglón'} factura ${fmt.format(r.cantidad)} y quedan ` +
        `${fmt.format(r.pendiente!)}`,
    )
    .join('; ')
  return {
    estado: 'error',
    mensaje: `Hay renglones que facturan más de lo que la orden tiene pendiente: ${detalle}.`,
  }
}

/**
 * Que lo que la factura cobra por renglón cierre contra su neto gravado --
 * pedido del usuario, 2026-09-15: "los importes que valen son los de la
 * factura", y hay proveedores que imprimen el precio de lista y descuentan
 * al pie. `resolverDescuentoGlobal` decide cómo cierra (subtotales netos o
 * brutos) y deriva el precio neto de cada renglón, que es el que se graba.
 *
 * Bloquea cuando no cierra de ninguna forma, o cuando a un renglón le falta
 * cantidad, precio o subtotal: decisión del usuario, bloquear y reprocesar
 * antes que dejar cargar un importe a mano.
 *
 * Solo artículos: en conceptos y tarjeta no hay renglones.
 */
export function validarRenglonesContraNeto(
  tipoFactura: string | null | undefined,
  resultado: ResultadoDescuento | null,
): ResultadoValidacion {
  if (tipoFactura !== 'articulos') {
    return { estado: 'ok', mensaje: 'No aplica: solo las facturas de artículos tienen renglones.' }
  }
  if (!resultado) {
    return { estado: 'error', mensaje: 'La factura no tiene renglones leídos. Reprocesá el comprobante.' }
  }
  // Bloquea tambien si cerro pero el campo "neto gravado" de la revision no
  // es la base real: ese campo es lo que va a CPA04.IMPORTE_NE. Pasa cuando
  // la factura imprime el neto ANTES del descuento general y la IA lo copio
  // (ZOZZOLI). Al leer, corregirNetoTrasDescuentoEn ya lo arregla solo; esto
  // cubre el caso en que el operador lo vuelva a tocar despues.
  return {
    estado: resultado.ok && !resultado.netoDesactualizado ? 'ok' : 'error',
    mensaje: describirDescuento(resultado),
  }
}

/**
 * Un renglón imputado y sus dos precios: el que cobra la factura (neto,
 * derivado del subtotal impreso) y el pactado en la orden de compra.
 */
export type PrecioContraOc = {
  codigo: string | null
  precioFactura: number | null
  precioOc: number | null
}

/**
 * Tolerancia al comparar precios: cuatro decimales es la precisión de
 * `CPA36.PRECIO` y de `CPA46.PRECIO_NET`, y el precio neto de la factura se
 * deriva dividiendo un subtotal de dos decimales por la cantidad -- medio
 * centavo de diferencia es redondeo, no una diferencia de precio.
 */
const TOLERANCIA_PRECIO = 0.005

/**
 * Que el precio que cobra la factura sea el pactado en la orden de compra.
 *
 * ADVIERTE, no bloquea -- decisión del usuario, 2026-09-15: la factura
 * manda, y la OC es la referencia contra la que se compara. Lo que sí
 * bloquea contra la OC es el código y la cantidad (`validarCotejoOc`,
 * `validarCantidadesOc`), que son el compromiso.
 */
export function validarPreciosContraOc(
  tipoFactura: string | null | undefined,
  renglones: PrecioContraOc[],
): ResultadoValidacion {
  if (tipoFactura !== 'articulos') return { estado: 'ok', mensaje: 'No aplica.' }
  if (renglones.length === 0) return { estado: 'ok', mensaje: 'No hay renglones imputados.' }

  const fmt = (n: number) => `$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const distintos = renglones.filter(
    (r) =>
      r.precioFactura !== null &&
      r.precioOc !== null &&
      Math.abs(r.precioFactura - r.precioOc) > TOLERANCIA_PRECIO,
  )
  if (distintos.length === 0) {
    return { estado: 'ok', mensaje: 'Los precios de la factura coinciden con los de la orden de compra.' }
  }
  const detalle = distintos
    .map((r) => `${r.codigo ?? '(sin código)'}: factura ${fmt(r.precioFactura!)}, orden ${fmt(r.precioOc!)}`)
    .join('; ')
  return {
    estado: 'advertencia',
    mensaje:
      `${distintos.length === 1 ? 'Un precio difiere' : `${distintos.length} precios difieren`} de la orden de compra ` +
      `(se registra el de la factura): ${detalle}.`,
  }
}

/**
 * Avisa qué líneas van a terminar sumadas por caer en el mismo código de
 * Tango. **No bloquea** -- decisión del usuario, 2026-09-08.
 *
 * Tango no admite el mismo código dos veces en un comprobante: `CPA18` tiene
 * un índice único `IX_0` sobre `(COD_PROVEE, TCOMP_IN_C, NCOMP_IN_C,
 * COD_IMPUES)`, una sola fila por impuesto. Pero eso no es un problema que
 * el operador tenga que resolver a mano: un impuesto que el comprobante
 * imprime en dos renglones y Tango identifica con un solo código es, para
 * Tango, un solo importe. El registro los suma (`agruparPorCodigo` en
 * comprobantes.ts), igual que ya hacía el asiento.
 *
 * Se avisa igual porque el operador tiene que poder darse cuenta si lo que
 * pasó es otra cosa: que se le haya escapado el código equivocado en una de
 * las dos líneas. Pasó de verdad con una factura de PETROARSA donde
 * "Impuesto interno a nivel ítem" e "IDC" habían quedado los dos en el 40, y
 * el segundo era en realidad el 51.
 *
 * Los slots de IVA de la cabecera entran también: no tienen un índice que lo
 * impida --son columnas, no filas--, pero de los 27.090 comprobantes de
 * `CPA04` ni uno solo repite un `COD_IVA` entre sus cinco slots.
 *
 * Las percepciones de Ingresos Brutos y los impuestos varios se cuentan
 * JUNTOS: las dos escriben en `CPA18` y el índice único no distingue de cuál
 * familia venía la línea.
 */
export function validarCodigosRepetidos(
  lineasIva: LineaAlicuota[],
  lineasPercep: LineaPercepcion[],
  lineasVarios: LineaVarios[],
): ResultadoValidacion {
  const repetidos = (etiquetas: { codigo: string; descripcion: string }[]): string[] => {
    const vistos = new Map<string, number>()
    for (const e of etiquetas) vistos.set(e.codigo, (vistos.get(e.codigo) ?? 0) + 1)
    return etiquetas
      .filter((e, i) => etiquetas.findIndex((x) => x.codigo === e.codigo) === i)
      .filter((e) => (vistos.get(e.codigo) ?? 0) > 1)
      .map((e) => `${e.codigo} — ${e.descripcion} (${vistos.get(e.codigo)} veces)`)
  }

  const iva = repetidos(
    lineasIva
      .filter((l) => l.estado === 'registra' && l.alicuota)
      .map((l) => ({ codigo: String(l.alicuota!.codigo), descripcion: l.alicuota!.descripcion })),
  )

  // Percepciones IIBB y varios van a la misma tabla: se cuentan juntos.
  const enCpa18 = repetidos([
    ...lineasPercep
      .filter((l) => l.estado === 'registra' && l.codigo)
      .map((l) => ({ codigo: l.codigo!.codigo, descripcion: l.codigo!.jurisdiccion })),
    ...lineasVarios
      .filter((l) => l.estado === 'registra' && l.codigo)
      .map((l) => ({ codigo: l.codigo, descripcion: l.descripcion ?? l.texto })),
  ])

  const todos = [...iva, ...enCpa18]
  if (todos.length === 0) {
    return { estado: 'ok', mensaje: 'Ningún código de Tango se repite.' }
  }
  return {
    estado: 'advertencia',
    mensaje:
      `Se registran sumados en una sola línea, porque Tango admite un código una sola vez ` +
      `por comprobante: ${todos.join('; ')}. Si alguna de las dos tendría que ir a otro ` +
      `código, cambiala antes de registrar.`,
  }
}


/**
 * Avisa si la observación no entra entera en la leyenda del comprobante.
 *
 * Desde el 2026-09-08 la observación va a `CPA04.LEYENDA` además de a los
 * renglones del asiento (pedido del usuario). En el asiento entra holgada
 * --`ASIENTO_CP.DESC_LEYENDA` admite 100-- pero la leyenda del comprobante
 * es de 30, y de las observaciones ya cargadas una las pasa.
 *
 * No bloquea: la factura se registra igual y el texto completo queda en el
 * asiento. Pero se avisa, porque un campo que el operador escribió y se
 * recorta solo es de las cosas que hay que ver antes y no después.
 */
export function validarLeyenda(observacion: string | null | undefined): ResultadoValidacion {
  const texto = (observacion ?? '').trim()
  if (texto === '') {
    return {
      estado: 'ok',
      mensaje: 'Sin observación: la leyenda del comprobante lleva la condición de compra.',
    }
  }
  if (texto.length <= LARGO_LEYENDA_COMPROBANTE) {
    return { estado: 'ok', mensaje: `Leyenda del comprobante: "${texto}".` }
  }
  return {
    estado: 'advertencia',
    mensaje:
      `La observación tiene ${texto.length} caracteres y la leyenda del comprobante admite ` +
      `${LARGO_LEYENDA_COMPROBANTE}: en Tango se va a ver "` +
      `${texto.slice(0, LARGO_LEYENDA_COMPROBANTE)}". En el asiento entra entera.`,
  }
}

const RE_CAE = /^\d{14}$/

/**
 * Acepta dd/mm/yyyy, dd.mm.yyyy y dd-mm-yyyy: la IA transcribe la fecha tal
 * como está impresa en el comprobante, y no todos los proveedores usan la
 * barra (ej. Topper imprime "30.07.2026"). Bug real, encontrado registrando
 * un comprobante real: antes solo aceptaba la barra, así que una fecha con
 * puntos no matcheaba, `parsearFechaArg` devolvía `null`, y el llamador
 * hacía `?? new Date()` -- la factura quedaba grabada en Tango con la
 * fecha de HOY en vez de la fecha real, en silencio, sin ningún error.
 *
 * El día y el mes admiten uno o dos dígitos (2026-09-16, pedido del
 * usuario): C C AGRO imprime "16/9/2026" y la validación la rechazaba como
 * ilegible. `normalizarFechaArg` la deja después en la forma canónica.
 */
export function parsearFechaArg(f: string): Date | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(f.trim())
  if (!m) return null
  const dia = Number(m[1])
  const mes = Number(m[2])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  const d = new Date(Number(m[3]), mes - 1, dia)
  // new Date() no rechaza dia=31 en un mes de 30: reindexa al mes
  // siguiente en vez de fallar. Detectarlo comparando el dia de vuelta.
  if (d.getDate() !== dia) return null
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * La misma fecha en la forma canónica `dd/mm/aaaa`, o `null` si no se
 * pudo interpretar. Es lo que se guarda en `fecha` al terminar de leer,
 * para que el operador vea siempre la misma forma y no la que cada
 * proveedor imprime ("16/9/2026", "30.07.2026", "01-06-2026").
 */
export function normalizarFechaArg(f: string | null | undefined): string | null {
  const d = parsearFechaArg((f ?? '').trim())
  if (!d) return null
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

export function validarCae(
  cae: string | null | undefined,
  vtocae: string | null | undefined,
  hoy: Date,
): ResultadoValidacion {
  const c = (cae ?? '').trim()
  if (!RE_CAE.test(c)) {
    return { estado: 'advertencia', mensaje: 'CAE con formato inválido: debe tener 14 dígitos.' }
  }
  const vto = parsearFechaArg((vtocae ?? '').trim())
  if (vto && vto < new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())) {
    return { estado: 'advertencia', mensaje: `CAE vencido el ${vtocae}.` }
  }
  return { estado: 'ok', mensaje: 'CAE válido.' }
}

/**
 * La fecha de emisión no tiene otro chequeo en "Listo para registrar" --
 * sin este, una fecha ilegible pasaba desapercibida hasta el momento de
 * grabar, donde el registro la reemplazaba en silencio por la fecha de
 * hoy (ver el comentario en `parsearFechaArg`).
 */
export function validarFecha(fecha: string | null | undefined): ResultadoValidacion {
  const f = (fecha ?? '').trim()
  if (!f) return { estado: 'error', mensaje: 'Falta la fecha de emisión.' }
  if (!parsearFechaArg(f)) {
    return { estado: 'error', mensaje: `No se pudo interpretar la fecha de emisión "${f}".` }
  }
  return { estado: 'ok', mensaje: 'Fecha de emisión válida.' }
}

export function validarFormatoNComp(
  ptovta: string | null | undefined,
  nro: string | null | undefined,
): ResultadoValidacion {
  const crudoPv = (ptovta ?? '').trim()
  const crudoN = (nro ?? '').trim()

  if (!crudoPv || !crudoN) {
    return { estado: 'error', mensaje: 'Falta punto de venta o número de comprobante.' }
  }
  if (!/^\d+$/.test(crudoPv) || !/^\d+$/.test(crudoN)) {
    return { estado: 'error', mensaje: 'El punto de venta y el número tienen que ser numéricos.' }
  }

  // Se miden sin los ceros de relleno, que es como los va a armar `nComp`:
  // un numero impreso a 12 digitos como "000020984549" entra sin problema
  // en los 8 que guarda Tango.
  const pv = sinCerosDeRelleno(crudoPv)
  const n = sinCerosDeRelleno(crudoN)

  if (pv.length > 5) {
    return { estado: 'error', mensaje: `El punto de venta tiene ${pv.length} dígitos, el máximo son 5.` }
  }
  if (n.length > 8) {
    return { estado: 'error', mensaje: `El número tiene ${n.length} dígitos, el máximo son 8.` }
  }
  return { estado: 'ok', mensaje: 'Formato de comprobante correcto.' }
}

export function validarCondCompra(condcompra: string | null | undefined): ResultadoValidacion {
  const v = (condcompra ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí una condición de compra antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Condición de compra elegida.' }
}

/**
 * Muestra, ya en la revisión, a qué alícuota de Tango va a ir cada par
 * porcivaN/impivaN -- antes se resolvía recién al apretar "Registrar en
 * Tango", así que un porcentaje que Tango no tiene se descubría en el
 * peor momento y sin señal previa en la pantalla.
 */
export function validarAlicuotas(lineas: LineaAlicuota[]): ResultadoValidacion {
  if (lineas.length === 0) {
    return { estado: 'ok', mensaje: 'No aplica.' }
  }

  // Dos motivos distintos, y el operador hace cosas distintas con cada uno:
  // un porcentaje que Tango no tiene se corrige en el porcentaje, y un
  // rotulo sin imputar se resuelve eligiendo el codigo (y esa eleccion queda
  // aprendida para ese proveedor). Desde el 2026-09-11 el segundo caso es
  // frecuente: los rotulos sin porcentaje impreso ya no caen a un codigo por
  // omision.
  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const conPorcentaje = sinCodigo.filter((l) => l.porcentaje > 0)
    const porRotulo = sinCodigo.filter((l) => l.porcentaje === 0)
    const partes: string[] = []
    if (conPorcentaje.length > 0) {
      const detalle = conPorcentaje
        .map((l) => `${formatPorcentaje(l.porcentaje)} (alícuota ${l.slot})`)
        .join(', ')
      partes.push(`Tango no tiene una alícuota de IVA para ${detalle}: corregí el porcentaje.`)
    }
    if (porRotulo.length > 0) {
      const detalle = porRotulo.map((l) => `alícuota ${l.slot}`).join(', ')
      partes.push(`Elegí el código de Tango de ${detalle} antes de registrar.`)
    }
    return { estado: 'error', mensaje: partes.join(' ') }
  }

  const omitidas = lineas.filter((l) => l.estado === 'omitida')
  const registran = lineas.filter((l) => l.estado === 'registra')

  const partes = registran.map(
    (l) => `${formatPorcentaje(l.porcentaje)} → ${l.alicuota!.descripcion} (cód. ${l.alicuota!.codigo})`,
  )

  // Una alícuota 0% con importe no se registra, pero su importe sí cuenta
  // en el total imputado: si no se avisara, el operador vería un total que
  // cierra y un comprobante que en Tango entra por menos.
  if (omitidas.length > 0) {
    const cuales = omitidas.map((l) => `alícuota ${l.slot}`).join(', ')
    const aviso = `La ${cuales} es 0% y no se registra.`
    return {
      estado: 'advertencia',
      mensaje: partes.length > 0 ? `${aviso} Se registra: ${partes.join('; ')}.` : aviso,
    }
  }

  return { estado: 'ok', mensaje: `IVA: ${partes.join('; ')}.` }
}

export function validarTipoFactura(tipoFactura: string | null | undefined): ResultadoValidacion {
  const v = (tipoFactura ?? '').trim()
  if (!v) {
    return { estado: 'error', mensaje: 'Elegí el tipo de factura antes de registrar.' }
  }
  return { estado: 'ok', mensaje: 'Tipo de factura elegido.' }
}

/**
 * La percepción de IVA del 3% no pasa por acá: va en los slots de IVA,
 * resuelta siempre al código 15 (ver resolverCodigoIva). Acá quedan las
 * líneas de Ingresos Brutos, que se identifican por jurisdicción.
 */
export function validarPercepciones(lineas: LineaPercepcion[]): ResultadoValidacion {
  if (lineas.length === 0) return { estado: 'ok', mensaje: 'No aplica.' }

  // En conceptos y articulos la jurisdiccion la resuelve la lista curada; en
  // tarjeta manda la tabla de imputacion del usuario, cargada por proveedor.
  // En los dos casos, una linea que no resuelve no puede llegar a CPA18 --se
  // grabaria con un codigo vacio-- y la imputa el operador. Su eleccion se
  // aprende para ese proveedor, asi que la proxima liquidacion del mismo
  // emisor ya sale sola.
  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const detalle = sinCodigo
      .map((l) => (l.texto ? `"${l.texto}" (percepción ${l.slot})` : `percepción ${l.slot}`))
      .join(', ')
    return {
      estado: 'error',
      mensaje: `Elegí el código de Tango de ${detalle} antes de registrar.`,
    }
  }

  const partes = lineas.map((l) => `${l.codigo!.jurisdiccion} → ${l.codigo!.codigo}`)
  return { estado: 'ok', mensaje: `Percepciones IIBB: ${partes.join('; ')}.` }
}

export function validarVarios(lineas: LineaVarios[]): ResultadoValidacion {
  if (lineas.length === 0) return { estado: 'ok', mensaje: 'No aplica.' }

  const sinCodigo = lineas.filter((l) => l.estado === 'sin-codigo')
  if (sinCodigo.length > 0) {
    const detalle = sinCodigo.map((l) => `impuesto vario ${l.slot}`).join(', ')
    return {
      estado: 'error',
      mensaje: `Elegí el código de Tango de ${detalle} antes de registrar.`,
    }
  }

  const partes = lineas.map((l) => `${l.codigo} — ${l.descripcion}`)
  return { estado: 'ok', mensaje: `Impuestos varios: ${partes.join('; ')}.` }
}

