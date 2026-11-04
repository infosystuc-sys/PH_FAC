import sql from 'mssql'
import { getPool } from '../db/pool'
import { esClaveValida, campoPorClave } from '@/lib/campos'
import { parsearImporteONulo } from '@/lib/formato'
import { usuarioActual } from '@/lib/usuario'
import type { Extraccion } from '../ia/extraccion'
import type { RenglonExtraido } from '@/lib/renglones'

export type CampoGuardado = {
  clave: string
  valorIA: string | null
  confianza: number | null
  valorFinal: string | null
  corregido: boolean
}

export type RenglonGuardado = RenglonExtraido & {
  id: number
  orden: number
  remitoNcompInS: string | null
  remitoNRenglS: number | null
  /** El número impreso del remito (`N_COMP`), para mostrarlo en pantalla. */
  remitoNumero: string | null
  /**
   * Lo que el remito entregó de este renglón, para poder cotejarlo en
   * pantalla contra lo que factura el proveedor. `null` en los renglones
   * que la factura cobra y no están en ningún remito.
   */
  cantidadRemito: string | null
  /**
   * El artículo que el operador eligió a mano. `null` mientras valga el
   * que resolvió el emparejamiento automático (`codigo`).
   */
  codigoFinal: string | null
  /** El % de bonificación de la línea, si la factura lo trae. */
  porcBonif: string | null
  /**
   * El código con el que el proveedor identifica el artículo en su factura.
   * Es lo que se guarda en CPA15 al confirmar el emparejamiento.
   */
  codProveedor: string | null
  /**
   * A qué renglón de qué orden de compra se imputa esta línea. Los tres
   * juntos son la clave que va a `CPA_OC_FACTURA` al registrar. `null` en
   * los comprobantes que todavía siguen el circuito viejo de remito.
   */
  ocNOrdenCo: string | null
  ocTalonario: number | null
  ocNRenglOc: number | null
  /** Lo que la OC tenía pendiente al elegirla, para cotejar en pantalla. */
  ocPendiente: string | null
  /** El renglón del PDF del que salió (PHF_RENGLON_PDF.ORDEN). Ver descuentoGlobal.ts. */
  pdfOrden: number | null
}

export type EntradaAuditoria = { fecha: Date; texto: string; usuario: string }

/** Un cargo del pie de una liquidación de tarjeta, ya guardado. */
export type CargoGuardado = {
  id: number
  orden: number
  concepto: string | null
  importe: string | null
  /** Si suma al neto gravado. */
  gravado: boolean
}

/** Un renglón leído del PDF, ya guardado. Solo sirve para cotejar contra la OC. */
export type RenglonPdfGuardado = {
  id: number
  orden: number
  codigo: string | null
  /** La descripción impresa: la clave para vincular un renglón sin código. */
  descripcion: string | null
  cantidad: string | null
  /** El precio unitario impreso, que puede ser el de lista. Ver descuentoGlobal.ts. */
  precioImpreso: string | null
  /** El subtotal impreso del renglón. */
  subtotalImpreso: string | null
}

export type Detalle = {
  campos: CampoGuardado[]
  renglones: RenglonGuardado[]
  cargos: CargoGuardado[]
  /** Lo que dice el papel, para cotejar contra `renglones`, que es lo que se factura. */
  renglonesPdf: RenglonPdfGuardado[]
  auditoria: EntradaAuditoria[]
}

type Ejecutor = { request(): sql.Request }

/**
 * Reemplaza los campos y renglones del comprobante por los de `e` y
 * devuelve la confianza promedio de los campos que vinieron con valor.
 *
 * Borra antes de insertar: PHF_CAMPO tiene UNIQUE (COMPROBANTE_ID, CLAVE),
 * asi que reprocesar sin borrar violaria la constraint. Es tambien lo que
 * hace que reprocesar descarte las correcciones manuales, que es el
 * comportamiento que la UI advierte.
 */
export async function guardarExtraccionEn(
  e: Ejecutor,
  comprobanteId: number,
  extraccion: Extraccion,
): Promise<number> {
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_CAMPO WHERE COMPROBANTE_ID = @id')
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id')
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_CARGO WHERE COMPROBANTE_ID = @id')
  await e.request().input('id', sql.Int, comprobanteId)
    .query('DELETE FROM PHF_RENGLON_PDF WHERE COMPROBANTE_ID = @id')

  const conValor: number[] = []

  for (const [clave, campo] of Object.entries(extraccion.campos)) {
    if (!esClaveValida(clave)) continue
    if (campo.valor !== null) conValor.push(campo.confianza)

    // El tope del catalogo tambien para lo que devuelve la IA, no solo para
    // lo que tipea el operador: `leyendaAsiento` la precarga el modelo con
    // lo que este escrito a mano en el comprobante, y va a una columna de 30
    // (CPA04.LEYENDA). Sin esto, una anotacion larga se recortaria recien al
    // grabar, adentro de Tango -- ver `maxLargo` en campos.ts.
    const max = campoPorClave(clave)?.maxLargo
    const valor = max && campo.valor !== null ? campo.valor.slice(0, max) : campo.valor

    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('clave', sql.VarChar(40), clave)
      .input('valor', sql.NVarChar(500), valor)
      .input('conf', sql.Decimal(5, 4), campo.valor === null ? null : campo.confianza)
      .query(`
        INSERT INTO PHF_CAMPO (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL)
        VALUES (@id, @clave, @valor, @conf, @valor)
      `)
  }

  let orden = 0
  for (const r of extraccion.renglones) {
    orden += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, orden)
      .input('codigo', sql.NVarChar(60), r.codigo)
      .input('desc', sql.NVarChar(500), r.descripcion)
      // Se parsean en JS con parsearImporteONulo -- ver el comentario en
      // desnormalizarBandejaEn (src/server/app/completarLectura.ts) sobre por qué un
      // REPLACE a ciegas en SQL rompe con comprobantes que mezclan
      // separadores en el mismo PDF.
      .input('cant', sql.Decimal(19, 4), parsearImporteONulo(r.cantidad))
      .input('pu', sql.Decimal(19, 4), parsearImporteONulo(r.precioUnitario))
      .input('imp', sql.Decimal(19, 4), parsearImporteONulo(r.importe))
      .query(`
        INSERT INTO PHF_RENGLON
          (COMPROBANTE_ID, ORDEN, CODIGO_IA, DESCRIPCION_IA,
           CANTIDAD_IA, PRECIO_UNITARIO_IA, IMPORTE_IA)
        VALUES (@id, @orden, @codigo, @desc, @cant, @pu, @imp)
      `)
  }

  // Los cargos que componen el neto gravado (solo tarjeta). `GRAVADO` sale
  // del default de la tabla: todos suman hasta que el operador diga lo
  // contrario, y esa correccion se aprende por proveedor.
  let ordenCargo = 0
  for (const c of extraccion.cargos) {
    ordenCargo += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, ordenCargo)
      .input('concepto', sql.NVarChar(200), c.concepto)
      .input('imp', sql.Decimal(19, 4), parsearImporteONulo(c.importe))
      .query(`
        INSERT INTO PHF_CARGO (COMPROBANTE_ID, ORDEN, CONCEPTO, IMPORTE)
        VALUES (@id, @orden, @concepto, @imp)
      `)
  }

  // Los renglones leidos del PDF (solo articulos). Van a su propia tabla y
  // no a PHF_RENGLON: ahi viven los que se van a facturar, que salen de la
  // orden de compra. Ver el comentario de PHF_RENGLON_PDF en migrate.ts.
  let ordenPdf = 0
  for (const r of extraccion.renglonesPdf) {
    ordenPdf += 1
    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('orden', sql.Int, ordenPdf)
      .input('codigo', sql.NVarChar(60), r.codigo)
      .input('descripcion', sql.NVarChar(300), r.descripcion === null ? null : r.descripcion.slice(0, 300))
      .input('cant', sql.Decimal(19, 4), parsearImporteONulo(r.cantidad))
      .input('precio', sql.Decimal(19, 4), parsearImporteONulo(r.precioUnitario))
      .input('subtotal', sql.Decimal(19, 4), parsearImporteONulo(r.subtotal))
      .query(`
        INSERT INTO PHF_RENGLON_PDF (COMPROBANTE_ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD, PRECIO_IMPRESO, SUBTOTAL_IMPRESO)
        VALUES (@id, @orden, @codigo, @descripcion, @cant, @precio, @subtotal)
      `)
  }

  if (conValor.length === 0) return 0
  return conValor.reduce((a, b) => a + b, 0) / conValor.length
}

export async function obtenerDetalleEn(e: Ejecutor, comprobanteId: number): Promise<Detalle> {
  const r = await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .query<Record<string, unknown>>(`
      SELECT CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL, CORREGIDO_POR_USUARIO
      FROM PHF_CAMPO WHERE COMPROBANTE_ID = @id ORDER BY CLAVE;

      SELECT ID, ORDEN, CODIGO_IA, DESCRIPCION_IA, CANTIDAD_IA,
             PRECIO_UNITARIO_IA, IMPORTE_IA, REMITO_NCOMP_IN_S, REMITO_N_RENGL_S,
             REMITO_NUMERO, CANTIDAD_REMITO, CODIGO_FINAL, PORC_BONIF, COD_PROVEEDOR,
             OC_N_ORDEN_CO, OC_TALONARIO, OC_N_RENGL_OC, OC_PENDIENTE, PDF_ORDEN
      FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;

      SELECT FECHA, TEXTO, USUARIO
      FROM PHF_AUDITORIA WHERE COMPROBANTE_ID = @id ORDER BY FECHA, ID;

      SELECT ID, ORDEN, CONCEPTO, IMPORTE, GRAVADO
      FROM PHF_CARGO WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;

      SELECT ID, ORDEN, CODIGO, DESCRIPCION, CANTIDAD, PRECIO_IMPRESO, SUBTOTAL_IMPRESO
      FROM PHF_RENGLON_PDF WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;
    `)

  const [c, g, a, cg, rp] = r.recordsets as unknown as Record<string, unknown>[][]

  return {
    campos: c.map((x) => ({
      clave: String(x.CLAVE),
      valorIA: x.VALOR_IA === null ? null : String(x.VALOR_IA),
      confianza: x.CONFIANZA === null ? null : Number(x.CONFIANZA),
      valorFinal: x.VALOR_FINAL === null ? null : String(x.VALOR_FINAL),
      corregido: Boolean(x.CORREGIDO_POR_USUARIO),
    })),
    renglones: g.map((x) => ({
      id: Number(x.ID),
      orden: Number(x.ORDEN),
      codigo: x.CODIGO_IA === null ? null : String(x.CODIGO_IA),
      descripcion: x.DESCRIPCION_IA === null ? null : String(x.DESCRIPCION_IA),
      cantidad: x.CANTIDAD_IA === null ? null : String(x.CANTIDAD_IA),
      precioUnitario: x.PRECIO_UNITARIO_IA === null ? null : String(x.PRECIO_UNITARIO_IA),
      importe: x.IMPORTE_IA === null ? null : String(x.IMPORTE_IA),
      remitoNcompInS: x.REMITO_NCOMP_IN_S === null ? null : String(x.REMITO_NCOMP_IN_S),
      remitoNRenglS: x.REMITO_N_RENGL_S === null ? null : Number(x.REMITO_N_RENGL_S),
      remitoNumero: x.REMITO_NUMERO === null ? null : String(x.REMITO_NUMERO),
      cantidadRemito: x.CANTIDAD_REMITO === null ? null : String(x.CANTIDAD_REMITO),
      codigoFinal: x.CODIGO_FINAL === null ? null : String(x.CODIGO_FINAL),
      porcBonif: x.PORC_BONIF === null ? null : String(x.PORC_BONIF),
      codProveedor: x.COD_PROVEEDOR === null ? null : String(x.COD_PROVEEDOR),
      ocNOrdenCo: x.OC_N_ORDEN_CO === null ? null : String(x.OC_N_ORDEN_CO),
      ocTalonario: x.OC_TALONARIO === null ? null : Number(x.OC_TALONARIO),
      ocNRenglOc: x.OC_N_RENGL_OC === null ? null : Number(x.OC_N_RENGL_OC),
      ocPendiente: x.OC_PENDIENTE === null ? null : String(x.OC_PENDIENTE),
      pdfOrden: x.PDF_ORDEN === null ? null : Number(x.PDF_ORDEN),
    })),
    renglonesPdf: rp.map((x) => ({
      id: Number(x.ID),
      orden: Number(x.ORDEN),
      codigo: x.CODIGO === null ? null : String(x.CODIGO),
      descripcion: x.DESCRIPCION === null ? null : String(x.DESCRIPCION),
      cantidad: x.CANTIDAD === null ? null : String(x.CANTIDAD),
      precioImpreso: x.PRECIO_IMPRESO === null ? null : String(x.PRECIO_IMPRESO),
      subtotalImpreso: x.SUBTOTAL_IMPRESO === null ? null : String(x.SUBTOTAL_IMPRESO),
    })),
    cargos: cg.map((x) => ({
      id: Number(x.ID),
      orden: Number(x.ORDEN),
      concepto: x.CONCEPTO === null ? null : String(x.CONCEPTO),
      importe: x.IMPORTE === null ? null : String(x.IMPORTE),
      gravado: Boolean(x.GRAVADO),
    })),
    auditoria: a.map((x) => ({
      fecha: new Date(x.FECHA as string),
      texto: String(x.TEXTO),
      usuario: String(x.USUARIO),
    })),
  }
}

export async function obtenerDetalle(comprobanteId: number): Promise<Detalle> {
  return obtenerDetalleEn(await getPool(), comprobanteId)
}

/**
 * Escribe un valor final para el campo. Por default asume que es una
 * corrección del operador y marca `CORREGIDO_POR_USUARIO = 1` — esa
 * columna es la única forma de distinguir después "la IA acertó" de "el
 * operador lo corrigió", y con eso se mide qué tan bien lee el modelo.
 * `VALOR_IA` no se toca nunca.
 *
 * Cuando quien resuelve el valor es el propio sistema (por ejemplo, el
 * proveedor que se completa por CUIT en la cola) hay que pasar
 * `{ corregidoPorUsuario: false }`: si no, se contamina esa métrica con
 * algo que ningún humano tocó.
 *
 * `registrado` y `existente` son terminales e inmutables (design/README.md
 * §2 para `registrado`; `existente` es el mismo criterio -- ver
 * `marcarExistenteEnTangoEn` en completarLectura.ts -- porque no hay nada que corregir
 * en una factura que ya está en Tango). Formulario no conoce el estado del
 * comprobante -- no se toca, está revisado y aprobado de una tarea
 * anterior -- así que el freno tiene que vivir en la escritura, no en el
 * input: si el comprobante está en cualquiera de los dos, el `USING` no
 * devuelve ninguna fila y el MERGE completo queda en un no-op, de forma
 * atómica (sin la ventana de carrera de un SELECT previo).
 */
export async function guardarCampoEn(
  e: Ejecutor,
  comprobanteId: number,
  clave: string,
  valor: string | null,
  { corregidoPorUsuario = true }: { corregidoPorUsuario?: boolean } = {},
): Promise<void> {
  if (!esClaveValida(clave)) {
    throw new Error(`Clave de campo desconocida: ${clave}`)
  }

  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('clave', sql.VarChar(40), clave)
    .input('valor', sql.NVarChar(500), valor)
    .input('corregido', sql.Bit, corregidoPorUsuario)
    .query(`
      MERGE PHF_CAMPO WITH (HOLDLOCK) AS destino
      USING (
        SELECT @id AS COMPROBANTE_ID, @clave AS CLAVE
        FROM PHF_COMPROBANTE
        WHERE ID = @id AND ESTADO NOT IN ('registrado', 'existente')
      ) AS origen
        ON destino.COMPROBANTE_ID = origen.COMPROBANTE_ID AND destino.CLAVE = origen.CLAVE
      WHEN MATCHED THEN
        UPDATE SET VALOR_FINAL = @valor, CORREGIDO_POR_USUARIO = @corregido
      WHEN NOT MATCHED THEN
        INSERT (COMPROBANTE_ID, CLAVE, VALOR_IA, CONFIANZA, VALOR_FINAL, CORREGIDO_POR_USUARIO)
        VALUES (@id, @clave, NULL, NULL, @valor, @corregido);
    `)
}

export async function auditarEn(
  e: Ejecutor,
  comprobanteId: number,
  texto: string,
): Promise<void> {
  await e
    .request()
    .input('id', sql.Int, comprobanteId)
    .input('texto', sql.NVarChar(500), texto)
    .input('usuario', sql.NVarChar(60), usuarioActual())
    .query(`
      INSERT INTO PHF_AUDITORIA (COMPROBANTE_ID, TEXTO, USUARIO)
      VALUES (@id, @texto, @usuario)
    `)
}

/**
 * El ID de un comprobante ya importado con este mismo hash de archivo, o
 * `null` si no hay ninguno. `guardarPdf` ya calcula este hash (ARCHIVO_HASH)
 * para cada PDF, pero hasta ahora nada lo usaba: la carga manual no lo
 * necesita (el operador ve lo que está subiendo), el escaneo automático de
 * carpetas sí -- es la forma de no crear un comprobante repetido si el
 * mismo PDF se dropea dos veces en la carpeta.
 */
export async function buscarComprobantePorHashEn(e: Ejecutor, hash: string): Promise<number | null> {
  const r = await e
    .request()
    .input('hash', sql.Char(64), hash)
    .query('SELECT TOP 1 ID FROM PHF_COMPROBANTE WHERE ARCHIVO_HASH = @hash')
  return r.recordset.length > 0 ? Number(r.recordset[0].ID) : null
}
