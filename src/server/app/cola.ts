import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { extraerDePdf, type Extraccion } from '../ia/extraccion'
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
import { normalizarCuit, parsearImporteONulo } from '@/lib/formato'
import { tipoFacturaODefault, CLAVES_REMITO, type TipoFactura } from '@/lib/tipoFactura'
import {
  MOTIVO_SIN_CONCEPTO,
  MOTIVO_REMITO_SIN_SALDO,
  MOTIVO_FACTURA_NO_COINCIDE,
} from '@/lib/observacion'
import { guardarExtraccionEn, guardarCampoEn, auditarEn, obtenerDetalleEn } from './detalle'
import { leerPdf } from './archivos'
import { cargarAprendidosEn } from './aprendizajeImpuestos'
import { normalizarTextoCondicion } from '@/server/tango/condicionesCompra'

export const MAX_INTENTOS = 3
export const MINUTOS_REPESCA = 10
export const CONCURRENCIA = 3

/** "CONTADO 1 DIA". Todas las facturas de conceptos arrancan con esta. */
export const COND_COMPRA_CONCEPTOS = '2'
const INTERVALO_MS = 2 * 60 * 1000

type Ejecutor = { request(): sql.Request }

export type Pendiente = { id: number; ruta: string; tipoFactura: TipoFactura }

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
    .input('fecha', sql.NVarChar(20), v('fecha'))
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

    const codProvee = await conTransaccion(async (tx) => {
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
      const conValor = Object.values(r.extraccion.campos).filter((c) => c.valor !== null).length
      await marcarLeidoEn(tx, id, prom, r.ms, r.modelo, conValor)
      await observarSinConceptoEn(tx, id, tipoFactura, cod)
      return cod
    })

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
