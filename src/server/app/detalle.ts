import sql from 'mssql'
import { getPool } from '../db/pool'
import { esClaveValida } from '@/lib/campos'
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
}

export type EntradaAuditoria = { fecha: Date; texto: string; usuario: string }

export type Detalle = {
  campos: CampoGuardado[]
  renglones: RenglonGuardado[]
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

  const conValor: number[] = []

  for (const [clave, campo] of Object.entries(extraccion.campos)) {
    if (!esClaveValida(clave)) continue
    if (campo.valor !== null) conValor.push(campo.confianza)

    await e
      .request()
      .input('id', sql.Int, comprobanteId)
      .input('clave', sql.VarChar(40), clave)
      .input('valor', sql.NVarChar(500), campo.valor)
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
      // desnormalizarBandejaEn (src/server/app/cola.ts) sobre por qué un
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
             REMITO_NUMERO, CANTIDAD_REMITO, CODIGO_FINAL, PORC_BONIF, COD_PROVEEDOR
      FROM PHF_RENGLON WHERE COMPROBANTE_ID = @id ORDER BY ORDEN;

      SELECT FECHA, TEXTO, USUARIO
      FROM PHF_AUDITORIA WHERE COMPROBANTE_ID = @id ORDER BY FECHA, ID;
    `)

  const [c, g, a] = r.recordsets as unknown as Record<string, unknown>[][]

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
 * `registrado` es terminal e inmutable (design/README.md §2): nada se
 * edita después de grabar en Tango. Formulario no conoce el estado del
 * comprobante -- no se toca, está revisado y aprobado de una tarea
 * anterior -- así que el freno tiene que vivir en la escritura, no en el
 * input: si el comprobante está `registrado`, el `USING` no devuelve
 * ninguna fila y el MERGE completo queda en un no-op, de forma atómica
 * (sin la ventana de carrera de un SELECT previo).
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
        WHERE ID = @id AND ESTADO <> 'registrado'
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
