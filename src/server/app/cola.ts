/**
 * La cola de procesamiento: el alta de un comprobante en el pipeline, el
 * worker que lo toma y `procesarUno`, que llama a la IA y encadena lo que
 * viene después (completarLectura.ts, remitosLectura.ts).
 */
import sql from 'mssql'
import { getPool } from '../db/pool'
import { conTransaccion } from '../db/tx'
import { extraerDePdf } from '../ia/extraccion'
import { extraerRenglonesFacturados } from '../ia/renglones'
import { cotejarRenglones, type RenglonFacturado } from '@/lib/cotejo'
import type { UsoTokens } from '@/lib/usoIa'
import {
  tipoFacturaODefault,
  TIPOS_FACTURA,
  TIPO_FACTURA_DEFAULT,
  vaContraOc,
  type TipoFactura,
} from '@/lib/tipoFactura'
import { guardarExtraccionEn, guardarCampoEn, auditarEn } from './detalle'
import { guardarPdf, leerPdf } from './archivos'
import { usuarioActual } from '@/lib/usuario'
import { normalizarFechaArg } from '@/lib/validaciones'
import { recalcularAVincularEn } from './ordenCompra'
import { aprenderLecturaEn } from './aprenderLectura'
import {
  COND_COMPRA_CONCEPTOS,
  desnormalizarBandejaEn,
  resolverProveedorEn,
  resolverCondicionCompraEn,
  ajustarNetoConIvaEn,
  corregirNetoTrasDescuentoEn,
  calcularFechaContableEn,
  mudarPercepcionIvaEn,
  aplicarCargosAprendidosEn,
  recalcularNetoDeCargosEn,
  completarIdentificacionTarjetaEn,
  marcarExistenteEnTangoEn,
  observarSinConceptoEn,
} from './completarLectura'
import {
  lineasDeRemitos,
  guardarRenglonesFacturadosEn,
  observarRemitosEn,
  observarDiferenciasEn,
} from './remitosLectura'

type Ejecutor = { request(): sql.Request }

export const MAX_INTENTOS = 3

export const MINUTOS_REPESCA = 10

export const CONCURRENCIA = 3

const INTERVALO_MS = 2 * 60 * 1000

export type Pendiente = { id: number; ruta: string; tipoFactura: TipoFactura }

/**
 * El punto de entrada real al pipeline, sin importar de donde vino el PDF
 * (carga manual en `acciones/comprobantes.ts`, o el escaneo automatico de carpetas en
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
 * Suma a la cabecera lo que consumió UN llamado a la API. Acumula en vez de
 * pisar: la segunda pasada de renglones, un reintento y un reproceso se
 * pagan igual, y lo que se quiere medir es cuánto costó el comprobante.
 * `uso` undefined (el llamado falló antes de que la API respondiera) no
 * suma nada: no hay tokens que contar, y en general tampoco se cobra.
 */
export async function sumarUsoIaEn(
  e: Ejecutor,
  id: number,
  uso: UsoTokens | undefined,
): Promise<void> {
  if (!uso) return
  await e
    .request()
    .input('id', sql.Int, id)
    .input('ent', sql.Int, uso.entrada)
    .input('sal', sql.Int, uso.salida)
    .input('cl', sql.Int, uso.cacheLectura)
    .input('ce', sql.Int, uso.cacheEscritura)
    .query(`
      UPDATE PHF_COMPROBANTE
      SET IA_LLAMADAS = ISNULL(IA_LLAMADAS, 0) + 1,
          IA_TOKENS_ENTRADA = ISNULL(IA_TOKENS_ENTRADA, 0) + @ent,
          IA_TOKENS_SALIDA = ISNULL(IA_TOKENS_SALIDA, 0) + @sal,
          IA_TOKENS_CACHE_LECTURA = ISNULL(IA_TOKENS_CACHE_LECTURA, 0) + @cl,
          IA_TOKENS_CACHE_ESCRITURA = ISNULL(IA_TOKENS_CACHE_ESCRITURA, 0) + @ce
      WHERE ID = @id
    `)
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

/** Extrae un comprobante y deja el resultado en la base. No lanza. */
export async function procesarUno({ id, ruta, tipoFactura }: Pendiente): Promise<void> {
  try {
    const pdf = await leerPdf(ruta)
    const r = await extraerDePdf(pdf, tipoFactura)
    // Suelto, antes y fuera de toda transacción: si lo que sigue falla y se
    // revierte, los tokens ya se pagaron y tienen que quedar contados.
    await sumarUsoIaEn(await getPool(), id, r.usage)

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
      await sumarUsoIaEn(await getPool(), id, segunda.usage)
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
