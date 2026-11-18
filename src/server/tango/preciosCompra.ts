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
 * Corregido el 2026-11-17 con la traza de Tango 26.1 (D:\TGA_MOV\envio_app,
 * punto 10): `FECHA_ULC`/`FECHA_REPOS` van con la fecha de EMISION, y el
 * UPDATE ya no toca `ID_CPA01`, `MON_CTE` ni `MON_CTE_UC` (siguen en el
 * INSERT de un articulo sin fila). La medicion de arriba coincidia con la
 * fecha contable y el ID del proveedor en esos 14 casos, pero la traza
 * muestra que Tango no los escribe al registrar.
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
  /**
   * La fecha que va a `FECHA_ULC` y `FECHA_REPOS`: la de EMISION del
   * comprobante, que es la que pone Tango (relevado el 17/11/2026). Hasta
   * ese dia la app mandaba la fecha contable; difieren solo cuando la
   * emision cae en un periodo cerrado.
   */
  fecha: Date
  /** `CPA04.COTIZACION`. En pesos es 1 y `PRECIO_U_E` termina igual al neto. */
  cotizacion: number
  /** `CPA04.MON_CTE`: true = moneda corriente (pesos). */
  monCte: boolean
  /**
   * Si viene, ademas graba la fila de `STA_AUDITORIA_COSTO_COMPRA` del
   * renglon, con el precio anterior y el actual (ver abajo).
   */
  auditoria?: AuditoriaCostoCompra
}

/**
 * Lo que identifica al renglon de factura en `STA_AUDITORIA_COSTO_COMPRA`.
 *
 * Tango graba una fila por renglon de factura despues de actualizar `STA12`
 * (`Sp_Auditoria_Costos_Compras`): 4 filas en la factura con OC de 4
 * renglones y 2 en la sin OC, relevadas el 17/11/2026. La app la graba
 * desde el 2026-11-17 (punto 9 de la revision). `ID_STA_AUDITORIA_COSTO_COMPRA`
 * no se manda: su default es `NEXT VALUE FOR SEQUENCE_STA_AUDITORIA_COSTO_COMPRA`.
 *
 * Columnas, todas copiadas de las filas que grabo Tango:
 *   FECHA_COMPROBANTE                 emision (`fecha`)
 *   COD_PROVEE, T_COMP, N_COMP        de la factura
 *   TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S vacios (2 y 8 espacios, como Tango) y 0
 *   COD_ARTICU, TIPO_MOVIMIENTO, USUARIO_INGRESO y TERMINAL_INGRESO van
 *   rellenos con espacios a la derecha hasta el largo de la columna (15, 60,
 *   150 y 255), como los graba Tango: son varchar, no se rellenan solos.
 *   TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C la factura y SU renglon (Tango repite
 *                                     el ultimo renglon en todas las filas
 *                                     de la factura sin OC; aca va el propio)
 *   NRO_SUCURS 0, MON_CTE y MON_CTE_UC = `CPA04.MON_CTE`, COTIZACION
 *   PRECIO_U_L/_U_E/_REP _ANTERIOR    lo que tenia STA12 antes (0 si no habia fila)
 *   PRECIO_U_L/_U_E/_REP _ACTUAL      lo que queda
 *   PRECIO_S_* (costo de stock)       0: la app no lo toca y Tango grabo 0
 *   ACT_PREC_U 1, ACT_REPOSI 1
 *   TIPO_MOVIMIENTO                   'Compras\Comprobantes\Factura sobre remito'
 *   FECHA_INGRESO (sin hora), HORA_INGRESO, USUARIO_INGRESO, TERMINAL_INGRESO
 */
export type AuditoriaCostoCompra = {
  tComp: string
  nComp: string
  tcompInC: string
  ncompInC: number
  nRenglC: number
  usuario: string
  /** `HHMMSS`. */
  hora: string
  terminal: string
}

export const TIPO_MOVIMIENTO_AUDITORIA = 'Compras\\Comprobantes\\Factura sobre remito'

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

  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const a = p.auditoria

  // El UPDATE del MERGE toca solo lo que cambio Tango en el relevamiento del
  // 17/11/2026: precios, proveedor de la ultima compra y fechas. `ID_CPA01`
  // NO: Tango le cambio el `COD_PROV_U` a dos articulos y les dejo el
  // `ID_CPA01` que tenian (es el proveedor habitual, no el de la ultima
  // compra). `MON_CTE`/`MON_CTE_UC` tampoco: no se confirmo con una factura
  // en otra moneda. Hasta ese dia la app pisaba los tres.
  //
  // Los precios anteriores se leen con bloqueo antes del MERGE, para la
  // auditoria: entre la lectura y el MERGE nadie puede cambiarlos.
  await e
    .request()
    .input('art', sql.VarChar(20), art)
    .input('precio', sql.Decimal(22, 7), p.precioNeto)
    .input('precioExt', sql.Decimal(22, 7), precioExtranjero)
    .input('prov', sql.VarChar(6), p.codProvee.trim())
    .input('fecha', sql.DateTime, p.fecha)
    .input('monCte', sql.Bit, p.monCte)
    .input('cotizacion', sql.Decimal(22, 7), cotizacion)
    .input('auditar', sql.Bit, a ? 1 : 0)
    .input('tComp', sql.VarChar(3), a?.tComp ?? '')
    .input('nComp', sql.VarChar(14), a?.nComp ?? '')
    .input('tcompInC', sql.VarChar(2), a?.tcompInC ?? '')
    .input('ncompInC', sql.Float, a?.ncompInC ?? 0)
    .input('nRenglC', sql.Int, a?.nRenglC ?? 0)
    .input('usuario', sql.VarChar(150), (a?.usuario ?? '').slice(0, 150))
    .input('hora', sql.VarChar(6), a?.hora ?? '')
    .input('terminal', sql.VarChar(255), a?.terminal ?? '')
    .input('hoy', sql.DateTime, hoy)
    .input('tipoMov', sql.VarChar(60), TIPO_MOVIMIENTO_AUDITORIA)
    .query(`
      DECLARE @antUL decimal(22, 7) = 0, @antUE decimal(22, 7) = 0, @antRep decimal(22, 7) = 0;
      SELECT @antUL = ISNULL(PRECIO_U_L, 0), @antUE = ISNULL(PRECIO_U_E, 0), @antRep = ISNULL(PRECIO_REP, 0)
      FROM STA12 WITH (UPDLOCK, ROWLOCK, HOLDLOCK) WHERE COD_ARTICU = @art;

      MERGE STA12 WITH (HOLDLOCK) AS destino
      USING (SELECT @art AS COD_ARTICU) AS origen
        ON destino.COD_ARTICU = origen.COD_ARTICU
      WHEN MATCHED THEN
        UPDATE SET
          PRECIO_U_L  = @precio,
          PRECIO_U_E  = @precioExt,
          FECHA_ULC   = @fecha,
          COD_PROV_U  = @prov,
          PRECIO_REP  = @precio,
          FECHA_REPOS = @fecha
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

      IF @auditar = 1
        INSERT INTO STA_AUDITORIA_COSTO_COMPRA (
          FECHA_COMPROBANTE, COD_PROVEE, T_COMP, N_COMP,
          TCOMP_IN_S, NCOMP_IN_S, N_RENGL_S, TCOMP_IN_C, NCOMP_IN_C, N_RENGL_C,
          NRO_SUCURS, MON_CTE, MON_CTE_UC, COTIZACION, COD_ARTICU,
          PRECIO_U_L_ANTERIOR, PRECIO_U_E_ANTERIOR, PRECIO_U_L_ACTUAL, PRECIO_U_E_ACTUAL,
          PRECIO_S_L_ANTERIOR, PRECIO_S_E_ANTERIOR, PRECIO_S_L_ACTUAL, PRECIO_S_E_ACTUAL,
          PRECIO_REP_ANTERIOR, PRECIO_REP_ACTUAL, ACT_PREC_U, ACT_REPOSI, TIPO_MOVIMIENTO,
          FECHA_INGRESO, HORA_INGRESO, USUARIO_INGRESO, TERMINAL_INGRESO
        ) VALUES (
          @fecha, @prov, @tComp, @nComp,
          '  ', '        ', 0, @tcompInC, @ncompInC, @nRenglC,
          0, @monCte, @monCte, @cotizacion, LEFT(@art + REPLICATE(' ', 15), 15),
          @antUL, @antUE, @precio, @precioExt,
          0, 0, 0, 0,
          @antRep, @precio, 1, 1, LEFT(@tipoMov + REPLICATE(' ', 60), 60),
          @hoy, @hora, LEFT(@usuario + REPLICATE(' ', 150), 150), LEFT(@terminal + REPLICATE(' ', 255), 255)
        );
    `)
}
