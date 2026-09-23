import sql from 'mssql'

type Ejecutor = { request(): sql.Request }

/**
 * El precio de última compra de un artículo: `STA12`, que la documentación
 * oficial de Stock llama "Precios artículos compra / costo".
 *
 * Tango la actualiza cada vez que registra una factura de compra, y esta
 * app no lo hacía: al 2026-09-22 había 32 artículos desactualizados por
 * las facturas que la app ya había registrado -- 19 con el precio de una
 * compra anterior y 13 sin fila. Cualquier informe de última compra o de
 * costo de reposición de esos artículos daba mal. Pedido del usuario,
 * 2026-09-21.
 *
 * Qué escribe Tango, medido sobre 14 artículos de 5 proveedores comparando
 * la fila de STA12 contra la última factura cargada DESDE Tango:
 *
 *   PRECIO_U_L            CPA46.PRECIO_NET                     14/14
 *   PRECIO_U_E            PRECIO_U_L / CPA04.COTIZACION        14/14
 *   FECHA_ULC             CPA04.FECHA_CONT, no la de emisión    6/6 con fechas distintas
 *   COD_PROV_U/ID_CPA01   el proveedor de la factura           14/14
 *   MON_CTE / MON_CTE_UC  CPA04.MON_CTE                        14/14
 *   PRECIO_REP/FECHA_REPOS  lo mismo que última compra         6.285 de 6.382 filas
 *
 * `PRECIO_REP`/`FECHA_REPOS` se escriben porque el parámetro de Tango
 * "actualizar el precio de reposición con el de la última compra" está
 * activo en esta instalación -- confirmado por el usuario, y coherente con
 * las 6.285 filas donde los dos precios coinciden.
 *
 * Lo que NO se toca: `PRECIO_S_L`, `PRECIO_S_E` y `FECHA_COSTO_ST` son el
 * costo de stock, que lo maneja otro proceso de Tango. Y las tres
 * `FECHA_MODI_*` las pone el trigger `TS_STA12_FECHA_MODI` cuando el precio
 * cambia: escribirlas a mano sería pelearle al trigger.
 *
 * `ID_STA12` se omite del INSERT a propósito, mismo criterio que `ID_CPA15`
 * en `asociarArticuloProveedor`: su default es
 * `NEXT VALUE FOR [SEQUENCE_STA12]`.
 *
 * Si el comprobante que se registra es más viejo que la última compra que
 * STA12 ya tiene, **pisa igual** -- decisión del usuario, 2026-09-23: es lo
 * que hace Tango, que guarda la última compra REGISTRADA y no la de fecha
 * más reciente.
 */
export type PrecioUltimaCompra = {
  codArticu: string
  /** `CPA46.PRECIO_NET`: lo que la factura cobra por unidad, ya neto. */
  precioNeto: number
  codProvee: string
  /** La fecha CONTABLE del comprobante, que es la que usa Tango. */
  fechaContable: Date
  /** `CPA04.COTIZACION`. En pesos es 1 y `PRECIO_U_E` termina igual al neto. */
  cotizacion: number
  /** `CPA04.MON_CTE`: true = moneda corriente (pesos). */
  monCte: boolean
}

export async function actualizarPrecioUltimaCompraEn(
  e: Ejecutor,
  p: PrecioUltimaCompra,
): Promise<void> {
  const art = p.codArticu.trim()
  if (!art || !(p.precioNeto > 0)) return

  // La cotización divide, así que un 0 leído del comprobante rompería el
  // cálculo: se cae a 1, que es lo que vale una factura en pesos.
  const cotizacion = p.cotizacion > 0 ? p.cotizacion : 1
  const precioExtranjero = Math.round((p.precioNeto / cotizacion) * 10000000) / 10000000

  await e
    .request()
    .input('art', sql.VarChar(20), art)
    .input('precio', sql.Decimal(22, 7), p.precioNeto)
    .input('precioExt', sql.Decimal(22, 7), precioExtranjero)
    .input('prov', sql.VarChar(6), p.codProvee.trim())
    .input('fecha', sql.DateTime, p.fechaContable)
    .input('monCte', sql.Bit, p.monCte)
    .query(`
      MERGE STA12 WITH (HOLDLOCK) AS destino
      USING (SELECT @art AS COD_ARTICU) AS origen
        ON destino.COD_ARTICU = origen.COD_ARTICU
      WHEN MATCHED THEN
        UPDATE SET
          PRECIO_U_L  = @precio,
          PRECIO_U_E  = @precioExt,
          FECHA_ULC   = @fecha,
          COD_PROV_U  = @prov,
          MON_CTE     = @monCte,
          MON_CTE_UC  = @monCte,
          PRECIO_REP  = @precio,
          FECHA_REPOS = @fecha,
          ID_CPA01    = (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE = @prov)
      WHEN NOT MATCHED THEN
        INSERT (COD_ARTICU, COD_PROV_U, FECHA_ULC, MON_CTE, MON_CTE_UC,
                PRECIO_U_L, PRECIO_U_E, PRECIO_REP, FECHA_REPOS,
                PRECIO_S_L, PRECIO_S_E, FECHA_COSTO_ST,
                FILLER, OBSERVACIONES, ID_STA11, ID_CPA01)
        VALUES (@art, @prov, @fecha, @monCte, @monCte,
                @precio, @precioExt, @precio, @fecha,
                0, 0, '1800-01-01',
                '', '',
                (SELECT ID_STA11 FROM STA11 WHERE COD_ARTICU = @art),
                (SELECT ID_CPA01 FROM CPA01 WHERE COD_PROVEE = @prov));
    `)
}
