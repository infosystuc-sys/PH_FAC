/**
 * El circuito de remitos de la lectura: buscar en Tango los remitos que
 * cita la factura, guardar los renglones facturados y observar lo que no
 * cierra. Lo llama `procesarUno` (cola.ts). Separado de cola.ts el
 * 2026-11-03.
 */
import sql from 'mssql'
import { sinonimosDelProveedor } from '../tango/articulos'
import { buscarRemitoPorNumero } from '../tango/remitos'
import {
  cotejarRenglones,
  describirDiferencias,
  type LineaRemito,
  type RenglonFacturado,
} from '@/lib/cotejo'
import { parsearImporteONulo } from '@/lib/formato'
import { CLAVES_REMITO, type TipoFactura } from '@/lib/tipoFactura'
import { MOTIVO_REMITO_SIN_SALDO, MOTIVO_FACTURA_NO_COINCIDE } from '@/lib/observacion'
import { auditarEn } from './detalle'

type Ejecutor = { request(): sql.Request }

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
