import { config as cargarEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'
import { conTransaccion } from '../src/server/db/tx'

cargarEnv({ path: '.env.local' })

type IndiceDef = { nombre: string; ddl: string }
type ColumnaDef = { nombre: string; ddl: string }
/**
 * A diferencia de una columna o un indice, un CHECK no se amplia con
 * ALTER...ADD: si el cuerpo cambia, hay que crear uno con nombre nuevo y
 * tirar el viejo, o los dos quedan activos a la vez y el viejo sigue
 * rechazando lo que el nuevo permitiria. `reemplazaA` nombra los
 * constraints que hay que dropear (si existen) antes de agregar este.
 */
type CheckDef = { nombre: string; ddl: string; reemplazaA?: string[] }
// `ddlTabla` es solo el CREATE TABLE (sin los indices), para que el camino
// de reparacion -- tabla existente a la que le falta un indice -- pueda
// emitir unicamente los CREATE INDEX que faltan sin volver a tocar la
// tabla. `indices` trae, por indice, su nombre (para el chequeo de
// idempotencia) y su propio DDL (para poder emitirlo suelto).
type Definicion = {
  tabla: string
  ddlTabla: string
  indices?: IndiceDef[]
  /**
   * Las columnas agregadas despues de la version inicial del esquema.
   * Estan tambien en `ddlTabla`, para que una base nueva se cree completa
   * de una; esta lista es solo el camino de reparacion de una base que
   * quedo en la version anterior. Hay un test que verifica que las dos
   * declaraciones no se separen.
   */
  columnas?: ColumnaDef[]
  /** Mismo criterio que `columnas`: version inicial del CHECK ya esta en
   *  `ddlTabla`, esta lista es solo el camino de reparacion. */
  checks?: CheckDef[]
}

const DEFINICIONES: Definicion[] = [
  {
    tabla: 'PHF_COMPROBANTE',
    ddlTabla: `
      CREATE TABLE PHF_COMPROBANTE (
        ID                  INT IDENTITY(1,1) NOT NULL,
        ARCHIVO_NOMBRE      NVARCHAR(260)  NOT NULL,
        ARCHIVO_RUTA        NVARCHAR(500)  NOT NULL,
        ARCHIVO_HASH        CHAR(64)       NOT NULL,
        ESTADO              VARCHAR(20)    NOT NULL,
        TIPO_FACTURA        VARCHAR(20)    NULL,
        RENGLONES_A_VINCULAR INT           NOT NULL CONSTRAINT DF_PHF_COMP_AVINCULAR DEFAULT 0,
        MOTIVO_OBSERVACION  NVARCHAR(60)   NULL,
        NOTA_OBSERVACION    NVARCHAR(1000) NULL,
        TIPO                VARCHAR(10)    NULL,
        PUNTO_VENTA         VARCHAR(10)    NULL,
        NUMERO              VARCHAR(20)    NULL,
        FECHA_EMISION       DATE           NULL,
        RAZON_SOCIAL        NVARCHAR(200)  NULL,
        CUIT                VARCHAR(15)    NULL,
        TOTAL               DECIMAL(19,4)  NULL,
        CONFIANZA_PROMEDIO  DECIMAL(5,4)   NULL,
        COD_PROVEE          VARCHAR(20)    NULL,
        TANGO_NCOMP_IN_C    FLOAT          NULL,
        TANGO_T_COMP        VARCHAR(10)    NULL,
        TANGO_N_COMP        VARCHAR(20)    NULL,
        FECHA_REGISTRO      DATETIME2      NULL,
        INTENTOS            INT            NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0,
        ERROR_MENSAJE       NVARCHAR(1000) NULL,
        EXTRACCION_MS       INT            NULL,
        EXTRACCION_MODELO   VARCHAR(40)    NULL,
        FECHA_ALTA          DATETIME2      NOT NULL CONSTRAINT DF_PHF_COMP_ALTA DEFAULT SYSDATETIME(),
        USUARIO_ALTA        NVARCHAR(60)   NOT NULL,
        FECHA_MODIF         DATETIME2      NULL,
        USUARIO_MODIF       NVARCHAR(60)   NULL,
        CONSTRAINT PK_PHF_COMPROBANTE PRIMARY KEY (ID),
        -- V2: agrega 'existente' (2026-08-23, ver CHECKS mas abajo para el
        -- camino de reparacion de una base que ya tenia la V1).
        CONSTRAINT CK_PHF_COMP_ESTADO_V2 CHECK (ESTADO IN
          ('procesando','leido','observacion','confirmado','registrado','error','existente'))
      );
    `,
    indices: [
      { nombre: 'IX_PHF_COMP_ESTADO', ddl: 'CREATE INDEX IX_PHF_COMP_ESTADO ON PHF_COMPROBANTE (ESTADO);' },
      {
        nombre: 'IX_PHF_COMP_DUP',
        ddl: 'CREATE INDEX IX_PHF_COMP_DUP ON PHF_COMPROBANTE (COD_PROVEE, TIPO, NUMERO);',
      },
      { nombre: 'IX_PHF_COMP_CUIT', ddl: 'CREATE INDEX IX_PHF_COMP_CUIT ON PHF_COMPROBANTE (CUIT);' },
      // La bandeja y la navegacion J/K ordenan por FECHA_ALTA DESC, ID DESC en
      // cada carga: a 20-100 comprobantes por dia son ~25.000 filas por año.
      {
        nombre: 'IX_PHF_COMP_ALTA',
        ddl: 'CREATE INDEX IX_PHF_COMP_ALTA ON PHF_COMPROBANTE (FECHA_ALTA DESC, ID DESC);',
      },
    ],
    // Un CHECK constraint no se agrega con ALTER...ADD como una columna: si
    // su cuerpo cambia (un valor mas para ESTADO) hay que reemplazarlo
    // entero, no ampliarlo. `reemplazaA` nombra los constraints viejos que
    // hay que tirar antes de crear este -- si se dejaran los dos activos,
    // el viejo (que no conoce 'existente') seguiria rechazando esa fila
    // aunque el nuevo la permita: SQL Server exige TODOS los CHECK de una
    // columna, no el ultimo que se agrego.
    checks: [
      {
        nombre: 'CK_PHF_COMP_ESTADO_V2',
        ddl: `ALTER TABLE PHF_COMPROBANTE ADD CONSTRAINT CK_PHF_COMP_ESTADO_V2 CHECK (ESTADO IN
          ('procesando','leido','observacion','confirmado','registrado','error','existente'));`,
        reemplazaA: ['CK_PHF_COMP_ESTADO'],
      },
    ],
    columnas: [
      { nombre: 'INTENTOS', ddl: 'INTENTOS INT NOT NULL CONSTRAINT DF_PHF_COMP_INTENTOS DEFAULT 0' },
      { nombre: 'ERROR_MENSAJE', ddl: 'ERROR_MENSAJE NVARCHAR(1000) NULL' },
      { nombre: 'EXTRACCION_MS', ddl: 'EXTRACCION_MS INT NULL' },
      { nombre: 'EXTRACCION_MODELO', ddl: 'EXTRACCION_MODELO VARCHAR(40) NULL' },
      // El tipo que el operador elige al importar. Vive en la cabecera y no
      // en PHF_CAMPO porque la cola lo necesita ANTES de extraer, para
      // elegir el prompt -- y porque guardarExtraccionEn borra los campos
      // del comprobante antes de reescribirlos, asi que un PHF_CAMPO
      // escrito en la importacion no sobreviviria a su propia extraccion.
      { nombre: 'TIPO_FACTURA', ddl: 'TIPO_FACTURA VARCHAR(20) NULL' },
      // Cuantos renglones de la factura (PHF_RENGLON_PDF) vienen sin codigo
      // de articulo y todavia no tienen una descripcion aprendida para este
      // proveedor (PHF_ARTICULO_PROVEEDOR). Es lo que alimenta la pestaña
      // "A vincular" de la bandeja (2026-09-17, pedido del usuario). Se
      // recalcula al terminar de leer y cada vez que el operador vincula una
      // descripcion; vive desnormalizado porque la bandeja lo filtra y lo
      // cuenta, y calcularlo por comprobante en cada listado seria una
      // consulta por fila.
      { nombre: 'RENGLONES_A_VINCULAR', ddl: 'RENGLONES_A_VINCULAR INT NOT NULL CONSTRAINT DF_PHF_COMP_AVINCULAR DEFAULT 0' },
    ],
  },
  {
    tabla: 'PHF_CAMPO',
    ddlTabla: `
      CREATE TABLE PHF_CAMPO (
        ID                     INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID         INT            NOT NULL,
        CLAVE                  VARCHAR(40)    NOT NULL,
        VALOR_IA               NVARCHAR(500)  NULL,
        CONFIANZA              DECIMAL(5,4)   NULL,
        VALOR_FINAL            NVARCHAR(500)  NULL,
        CORREGIDO_POR_USUARIO  BIT            NOT NULL CONSTRAINT DF_PHF_CAMPO_CORR DEFAULT 0,
        CONSTRAINT PK_PHF_CAMPO PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_CAMPO UNIQUE (COMPROBANTE_ID, CLAVE),
        CONSTRAINT FK_PHF_CAMPO_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    // Los cargos que componen el neto gravado de una liquidacion de tarjeta
    // (arancel, comision, costo financiero...). Ver src/lib/cargos.ts para
    // por que se piden desglosados en vez de pedir el neto ya sumado.
    //
    // Tabla propia y no PHF_RENGLON: un renglon es mercaderia que entro por
    // un remito, con codigo de articulo, cantidad y precio unitario, y se
    // imputa a CPA46. Un cargo es una linea del pie del resumen que solo
    // aporta importe a la base gravada. Meterlos en la misma tabla obligaria
    // a dejar la mitad de las columnas en NULL en cada fila y a que todo lo
    // que hoy lee PHF_RENGLON tuviera que aprender a saltearlos.
    tabla: 'PHF_CARGO',
    ddlTabla: `
      CREATE TABLE PHF_CARGO (
        ID              INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID  INT            NOT NULL,
        ORDEN           INT            NOT NULL,
        -- El rotulo tal como lo imprime la procesadora ("Arancel de ley").
        CONCEPTO        NVARCHAR(200)  NULL,
        IMPORTE         DECIMAL(19,4)  NULL,
        -- Si este cargo suma al neto gravado. Arranca en 1 y el operador lo
        -- corrige; esa correccion se aprende por proveedor.
        GRAVADO         BIT            NOT NULL CONSTRAINT DF_PHF_CARGO_GRAVADO DEFAULT 1,
        CONSTRAINT PK_PHF_CARGO PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_CARGO UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_CARGO_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
  },
  {
    // Los renglones tal como los lee la IA del PDF de una factura de
    // articulos: solo codigo y cantidad. Sirven para UNA cosa -- cotejarlos
    // contra la orden de compra imputada -- y no se graban en Tango.
    //
    // Tabla propia y no PHF_RENGLON: ahi viven los renglones que SI se van
    // a facturar, que desde 2026-09-06 salen de la OC. Son dos cosas
    // distintas y ademas incompatibles en la misma tabla: PHF_RENGLON tiene
    // UNIQUE (COMPROBANTE_ID, ORDEN) y las dos numeran desde 1, asi que
    // compartirla haria chocar la lectura del PDF contra el detalle a
    // facturar.
    tabla: 'PHF_RENGLON_PDF',
    ddlTabla: `
      CREATE TABLE PHF_RENGLON_PDF (
        ID              INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID  INT            NOT NULL,
        ORDEN           INT            NOT NULL,
        -- El codigo tal como lo imprime el proveedor, sin interpretar: puede
        -- ser el nuestro o el de el (ver CPA15.COD_SINONI).
        CODIGO          NVARCHAR(60)   NULL,
        CANTIDAD        DECIMAL(19,4)  NULL,
        PRECIO_IMPRESO  DECIMAL(19,4)  NULL,
        SUBTOTAL_IMPRESO DECIMAL(19,4) NULL,
        DESCRIPCION     NVARCHAR(300)  NULL,
        CONSTRAINT PK_PHF_RENGLON_PDF PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_RENGLON_PDF UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_RENGLON_PDF_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
    columnas: [
      // El precio unitario y el subtotal tal como los imprime la factura,
      // desde el 2026-09-15: los importes que valen son los de la factura
      // (decision del usuario), asi que hay que leerlos. El precio impreso
      // puede ser el de lista, bruto, con el descuento aplicado recien al pie
      // o ya dentro del subtotal: descuentoGlobal.ts decide cual de los dos.
      { nombre: 'PRECIO_IMPRESO', ddl: 'PRECIO_IMPRESO DECIMAL(19,4) NULL' },
      { nombre: 'SUBTOTAL_IMPRESO', ddl: 'SUBTOTAL_IMPRESO DECIMAL(19,4) NULL' },
      // La descripcion del articulo tal como la imprime la factura. Es la
      // clave para vincular un renglon SIN codigo con un articulo de Tango
      // (2026-09-17, pedido del usuario): hay proveedores que no imprimen
      // codigo, y lo unico estable de un renglon a otro es como describen la
      // mercaderia.
      { nombre: 'DESCRIPCION', ddl: 'DESCRIPCION NVARCHAR(300) NULL' },
    ],
  },
  {
    tabla: 'PHF_RENGLON',
    ddlTabla: `
      CREATE TABLE PHF_RENGLON (
        ID                  INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID      INT            NOT NULL,
        ORDEN               INT            NOT NULL,
        CODIGO_IA           NVARCHAR(60)   NULL,
        DESCRIPCION_IA      NVARCHAR(500)  NULL,
        CANTIDAD_IA         DECIMAL(19,4)  NULL,
        PRECIO_UNITARIO_IA  DECIMAL(19,4)  NULL,
        IMPORTE_IA          DECIMAL(19,4)  NULL,
        REMITO_NCOMP_IN_S   VARCHAR(20)    NULL,
        REMITO_N_RENGL_S    INT            NULL,
        REMITO_NUMERO       VARCHAR(20)    NULL,
        CANTIDAD_REMITO     DECIMAL(19,4)  NULL,
        CODIGO_FINAL        NVARCHAR(60)   NULL,
        PORC_BONIF          DECIMAL(9,4)   NULL,
        COD_PROVEEDOR       NVARCHAR(60)   NULL,
        OC_N_ORDEN_CO       VARCHAR(14)    NULL,
        OC_TALONARIO        INT            NULL,
        OC_N_RENGL_OC       INT            NULL,
        OC_PENDIENTE        DECIMAL(19,4)  NULL,
        PDF_ORDEN           INT            NULL,
        CONSTRAINT PK_PHF_RENGLON PRIMARY KEY (ID),
        CONSTRAINT UQ_PHF_RENGLON UNIQUE (COMPROBANTE_ID, ORDEN),
        CONSTRAINT FK_PHF_RENGLON_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
    columnas: [
      // El número impreso del remito (`N_COMP`, ej. "R0502600531798"), para
      // mostrarlo junto al renglón sin depender de que el remito siga
      // apareciendo en `buscarRemitosPendientes` -- una vez que se consume
      // del todo, desaparece de esa lista, y este dato quedaría huérfano si
      // no se guardara acá. `REMITO_NCOMP_IN_S` (el código interno) sigue
      // siendo la clave real para el join contra STA14/STA20 al registrar.
      { nombre: 'REMITO_NUMERO', ddl: 'REMITO_NUMERO VARCHAR(20) NULL' },
      // Lo que el remito entrego de ESE renglon, para poder mostrarlo al
      // lado de lo que factura el proveedor. Se guarda en vez de releerlo
      // en pantalla por el mismo motivo que REMITO_NUMERO: un remito que se
      // consume del todo desaparece de la lista de pendientes, y despues de
      // registrar el dato quedaria huerfano.
      { nombre: 'CANTIDAD_REMITO', ddl: 'CANTIDAD_REMITO DECIMAL(19,4) NULL' },
      // El articulo que el operador eligio a mano cuando el emparejamiento
      // automatico se equivoco. Mismo criterio que VALOR_IA/VALOR_FINAL en
      // PHF_CAMPO: CODIGO_IA guarda lo que resolvio el sistema y no se
      // pisa, para no contaminar la medicion de que tan bien empareja.
      { nombre: 'CODIGO_FINAL', ddl: 'CODIGO_FINAL NVARCHAR(60) NULL' },
      // El % de bonificacion de la linea. El precio unitario que imprime la
      // factura es el de lista, ANTES del descuento, y el importe ya viene
      // descontado: sin esto la suma de los renglones no cierra contra el
      // neto gravado. Va a CPA46.PORCE_DCTO al registrar.
      { nombre: 'PORC_BONIF', ddl: 'PORC_BONIF DECIMAL(9,4) NULL' },
      // El codigo con el que el proveedor identifica el articulo en SU
      // factura. Se guarda para poder asociarlo despues a nuestro articulo
      // en CPA15.COD_SINONI, que es la funcion que Tango tiene prevista.
      { nombre: 'COD_PROVEEDOR', ddl: 'COD_PROVEEDOR NVARCHAR(60) NULL' },
      // A que renglon de que orden de compra se imputa esta linea. Desde
      // 2026-09-06 las facturas de articulos se imputan a una OC y no se
      // cotejan contra un remito (decision del usuario). Los tres datos
      // juntos son la clave que despues va a CPA_OC_FACTURA:
      // TALONARIO_OC + N_ORDEN_CO + N_RENGL_OC.
      //
      // Van en el renglon y no en la cabecera a proposito: hoy la pantalla
      // deja elegir una sola OC por factura, pero hay 64 facturas
      // historicas repartidas entre dos OC, y el usuario pidio dejar la
      // puerta abierta. Con la OC en el renglon, soportar varias es un
      // cambio de pantalla y no de modelo de datos.
      { nombre: 'OC_N_ORDEN_CO', ddl: 'OC_N_ORDEN_CO VARCHAR(14) NULL' },
      { nombre: 'OC_TALONARIO', ddl: 'OC_TALONARIO INT NULL' },
      { nombre: 'OC_N_RENGL_OC', ddl: 'OC_N_RENGL_OC INT NULL' },
      // Lo que la OC tiene pendiente de facturar en ese renglon, congelado
      // al momento de elegirla. Mismo criterio que CANTIDAD_REMITO: sirve
      // para mostrar al lado de lo que se factura, y una vez consumida la
      // OC deja de aparecer en la lista de pendientes y el dato quedaria
      // huerfano. El pendiente REAL se relee de Tango al registrar.
      { nombre: 'OC_PENDIENTE', ddl: 'OC_PENDIENTE DECIMAL(19,4) NULL' },
      // De que renglon del PDF (PHF_RENGLON_PDF.ORDEN) salio este renglon
      // imputado. Desde el 2026-09-15 los importes que valen son los de la
      // factura, y el precio neto de cada renglon se deriva del subtotal
      // impreso (ver descuentoGlobal.ts): sin este vinculo no hay forma de
      // saber que subtotal le corresponde a que renglon de la OC.
      { nombre: 'PDF_ORDEN', ddl: 'PDF_ORDEN INT NULL' },
    ],
  },
  {
    tabla: 'PHF_AUDITORIA',
    ddlTabla: `
      CREATE TABLE PHF_AUDITORIA (
        ID              INT IDENTITY(1,1) NOT NULL,
        COMPROBANTE_ID  INT            NOT NULL,
        FECHA           DATETIME2      NOT NULL CONSTRAINT DF_PHF_AUD_FECHA DEFAULT SYSDATETIME(),
        TEXTO           NVARCHAR(500)  NOT NULL,
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_AUDITORIA PRIMARY KEY (ID),
        CONSTRAINT FK_PHF_AUD_COMP FOREIGN KEY (COMPROBANTE_ID)
          REFERENCES PHF_COMPROBANTE (ID) ON DELETE CASCADE
      );
    `,
    indices: [{ nombre: 'IX_PHF_AUD_COMP', ddl: 'CREATE INDEX IX_PHF_AUD_COMP ON PHF_AUDITORIA (COMPROBANTE_ID, FECHA);' }],
  },
  {
    tabla: 'PHF_ALICUOTA_PROVEEDOR',
    ddlTabla: `
      CREATE TABLE PHF_ALICUOTA_PROVEEDOR (
        ID              INT IDENTITY(1,1) NOT NULL,
        COD_PROVEE      VARCHAR(20)    NOT NULL,
        -- 'iva' | 'percepcion' | 'condicion' (2026-08-23: condicion de
        -- compra, agregada sin migracion aparte -- exactamente lo que este
        -- comentario anticipaba). Sin CHECK: un cuarto tipo tampoco deberia
        -- pedir una migracion.
        TIPO            VARCHAR(20)    NOT NULL,
        -- Como se identifica el dato en la factura de este proveedor, ya
        -- normalizado (ver aprendizajeImpuestos.ts): en 'iva' es el
        -- porcentaje ("21", "10.5"); en 'percepcion' es la jurisdiccion sin
        -- acentos ni mayusculas ("tucuman"); en 'condicion' es el texto de
        -- condicion de pago/venta que imprime el proveedor, tambien sin
        -- acentos ni mayusculas ("cuenta corriente"). Se guarda normalizado
        -- -- no la grafia exacta de esa factura puntual -- para que dos
        -- facturas del mismo proveedor con distinto casing/acentuacion
        -- sigan pegando en la misma fila.
        DESCRIPCION     NVARCHAR(200)  NOT NULL,
        COD_TANGO       VARCHAR(10)    NOT NULL,
        FECHA_ALTA      DATETIME2      NOT NULL CONSTRAINT DF_PHF_ALIPROV_ALTA DEFAULT SYSDATETIME(),
        FECHA_MODIF     DATETIME2      NULL,
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_ALICUOTA_PROVEEDOR PRIMARY KEY (ID),
        -- Un proveedor no puede tener dos codigos distintos aprendidos para
        -- el mismo texto: la ultima correccion del operador reemplaza a la
        -- anterior (MERGE en aprenderImpuestoEn), no se acumulan filas.
        CONSTRAINT UQ_PHF_ALIPROV UNIQUE (COD_PROVEE, TIPO, DESCRIPCION)
      );
    `,
    indices: [
      {
        nombre: 'IX_PHF_ALIPROV_LOOKUP',
        ddl: 'CREATE INDEX IX_PHF_ALIPROV_LOOKUP ON PHF_ALICUOTA_PROVEEDOR (COD_PROVEE, TIPO);',
      },
    ],
  },
  {
    // Que articulo nuestro es cada DESCRIPCION que imprime un proveedor que
    // no imprime codigo de articulo (2026-09-17, pedido del usuario). Es la
    // contraparte de CPA15.COD_SINONI para el caso en que no hay codigo: ahi
    // no entra -- COD_SINONI es varchar(15) -- y ademas es una tabla de Tango
    // que no corresponde llenar con textos largos. Lo enseña el operador una
    // vez desde la tarjeta de la orden de compra, y las facturas siguientes
    // del mismo proveedor emparejan solas.
    tabla: 'PHF_ARTICULO_PROVEEDOR',
    ddlTabla: `
      CREATE TABLE PHF_ARTICULO_PROVEEDOR (
        ID              INT IDENTITY(1,1) NOT NULL,
        COD_PROVEE      VARCHAR(20)    NOT NULL,
        -- La descripcion impresa, normalizada (sin acentos ni mayusculas,
        -- espacios colapsados): dos facturas del mismo proveedor con distinto
        -- casing tienen que pegar en la misma fila. Ver normalizarDescripcionArticulo.
        DESCRIPCION     NVARCHAR(300)  NOT NULL,
        -- Nuestro codigo, tal como esta en STA11 (con sus espacios, si los tiene).
        COD_ARTICU      VARCHAR(20)    NOT NULL,
        -- 1 = este renglon es un CARGO del proveedor y no va contra una orden
        -- de compra: se registra igual, en CPA46 y en el asiento, pero sin
        -- vinculo en CPA_OC_FACTURA ni descuento de CPA36. Lo marca el
        -- operador y se recuerda por proveedor+descripcion (2026-09-22,
        -- pedido del usuario: RED DEL INTERIOR factura "GESTION DE COMPRA 1%"
        -- y "GESTION ROSARIO LOGISTICA S.A."). No se puede deducir solo: esos
        -- dos articulos existen en OTRAS ordenes pendientes del mismo
        -- proveedor, asi que "no esta en ninguna OC" no los distingue de
        -- "falta imputar la orden correcta".
        SIN_OC          BIT            NOT NULL CONSTRAINT DF_PHF_ARTPROV_SINOC DEFAULT 0,
        FECHA_ALTA      DATETIME2      NOT NULL CONSTRAINT DF_PHF_ARTPROV_ALTA DEFAULT SYSDATETIME(),
        FECHA_MODIF     DATETIME2      NULL,
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_ARTICULO_PROVEEDOR PRIMARY KEY (ID),
        -- Una descripcion de un proveedor apunta a UN articulo: la ultima
        -- eleccion del operador reemplaza a la anterior (MERGE).
        CONSTRAINT UQ_PHF_ARTPROV UNIQUE (COD_PROVEE, DESCRIPCION)
      );
    `,
    columnas: [
      { nombre: 'SIN_OC', ddl: 'SIN_OC BIT NOT NULL CONSTRAINT DF_PHF_ARTPROV_SINOC DEFAULT 0' },
    ],
  },
  {
    tabla: 'PHF_LECTURA_PROVEEDOR',
    // Como lee la app las facturas de CADA proveedor (2026-09-30, pedido del
    // usuario: "que la app guarde la forma en la que interpreta cada caso
    // para cada proveedor").
    //
    // Hasta ahora lo aprendido era siempre por ARTICULO: el sinonimo en
    // CPA15, la descripcion en PHF_ARTICULO_PROVEEDOR. Eso no alcanza para
    // los proveedores con escala, donde lo que hay que recordar no es un
    // articulo sino COMO viene armado el codigo en el papel: DASS imprime el
    // color en una columna aparte y en Tango va pegado al codigo
    // (1261095 + 140 = 1261095140); TOPPER desglosa las cantidades por talle
    // debajo del renglon. Aprendido una vez, sirve para todos los articulos
    // del proveedor -- incluso los que nunca se facturaron, que es
    // justamente donde lo aprendido por articulo no ayuda.
    ddlTabla: `
      CREATE TABLE PHF_LECTURA_PROVEEDOR (
        COD_PROVEE     VARCHAR(20)   NOT NULL,
        -- 'columna-color' | 'desglose-talle' | 'ninguna'. Ver
        -- src/lib/lecturaProveedor.ts, que es donde vive el significado.
        ESCALA         VARCHAR(20)   NOT NULL,
        -- En cuantos comprobantes se confirmo. Una regla vista una sola vez
        -- se aplica igual, pero el conteo permite distinguir la que ya es
        -- costumbre del proveedor de la que se vio una vez.
        COMPROBANTES   INT           NOT NULL CONSTRAINT DF_PHF_LECTPROV_COMP DEFAULT 0,
        -- Si la puso el operador a mano. Una regla elegida por una persona
        -- no la pisa la deduccion automatica.
        MANUAL         BIT           NOT NULL CONSTRAINT DF_PHF_LECTPROV_MANUAL DEFAULT 0,
        ACTUALIZADO    DATETIME2     NOT NULL CONSTRAINT DF_PHF_LECTPROV_FECHA DEFAULT SYSDATETIME(),
        USUARIO        NVARCHAR(60)  NULL,
        CONSTRAINT PK_PHF_LECTURA_PROVEEDOR PRIMARY KEY (COD_PROVEE)
      );
    `,
  },
  {
    tabla: 'PHF_ARCA_IMPORTACION',
    // Cada archivo de "Mis Comprobantes" de ARCA que se sube (2026-10-09,
    // pedido del usuario: verificar que lo cargado en Tango coincida con lo
    // que ARCA informa). Se guarda la importacion aparte de las filas para
    // poder re-subir el mismo periodo sin duplicar: la importacion nueva
    // reemplaza a la anterior con sus filas (FK en cascada).
    ddlTabla: `
      CREATE TABLE PHF_ARCA_IMPORTACION (
        ID              INT IDENTITY(1,1) NOT NULL,
        ARCHIVO_NOMBRE  NVARCHAR(260)  NOT NULL,
        -- El rango que el archivo REALMENTE cubre, calculado de las filas y
        -- no pedido al operador: es lo que dice hasta donde la ausencia de
        -- un comprobante en ARCA significa algo.
        PERIODO_DESDE   DATE           NULL,
        PERIODO_HASTA   DATE           NULL,
        FILAS           INT            NOT NULL CONSTRAINT DF_PHF_ARCAIMP_FILAS DEFAULT 0,
        FECHA_ALTA      DATETIME2      NOT NULL CONSTRAINT DF_PHF_ARCAIMP_ALTA DEFAULT SYSDATETIME(),
        USUARIO         NVARCHAR(60)   NOT NULL,
        CONSTRAINT PK_PHF_ARCA_IMPORTACION PRIMARY KEY (ID)
      );
    `,
  },
  {
    tabla: 'PHF_ARCA_COMPROBANTE',
    // Una fila por comprobante informado por ARCA. Los importes van en
    // DECIMAL y no como texto: a diferencia de lo que lee la IA de un PDF
    // --que se guarda crudo para que el operador lo coteje-- esto viene de
    // un archivo oficial y ya esta normalizado.
    ddlTabla: `
      CREATE TABLE PHF_ARCA_COMPROBANTE (
        ID              INT IDENTITY(1,1) NOT NULL,
        IMPORTACION_ID  INT            NOT NULL,
        FECHA_EMISION   DATE           NOT NULL,
        -- El codigo numerico de ARCA (1 = Factura A, 6 = Factura B, ...) y
        -- la letra deducida. Se guardan los dos: el codigo es el dato
        -- oficial y la letra es con la que se arma N_COMP de Tango.
        TIPO_CODIGO     INT            NOT NULL,
        TIPO_LETRA      VARCHAR(2)     NULL,
        PUNTO_VENTA     INT            NOT NULL,
        NUMERO          BIGINT         NOT NULL,
        CUIT_EMISOR     VARCHAR(15)    NOT NULL,
        RAZON_EMISOR    NVARCHAR(200)  NULL,
        IMPORTE_TOTAL   DECIMAL(19,4)  NOT NULL,
        IMPORTE_NETO    DECIMAL(19,4)  NULL,
        IMPORTE_IVA     DECIMAL(19,4)  NULL,
        CONSTRAINT PK_PHF_ARCA_COMPROBANTE PRIMARY KEY (ID),
        CONSTRAINT FK_PHF_ARCACOMP_IMP FOREIGN KEY (IMPORTACION_ID)
          REFERENCES PHF_ARCA_IMPORTACION (ID) ON DELETE CASCADE
      );
    `,
    indices: [
      // Por esta clave se cruza contra Tango, y son miles de filas.
      {
        nombre: 'IX_PHF_ARCACOMP_CLAVE',
        ddl: 'CREATE INDEX IX_PHF_ARCACOMP_CLAVE ON PHF_ARCA_COMPROBANTE (CUIT_EMISOR, PUNTO_VENTA, NUMERO)',
      },
    ],
  },
  {
    tabla: 'PHF_CONFIGURACION',
    // Una sola fila fija (ID=1) -- primera tabla de configuracion global de
    // la app (2026-08-26, importacion automatica desde carpetas). Todo lo
    // que hacia falta antes vivia en variables de entorno; esto es
    // configurable desde la propia app, asi que necesita persistirse.
    ddlTabla: `
      CREATE TABLE PHF_CONFIGURACION (
        ID                  INT            NOT NULL,
        CARPETA_RAIZ        NVARCHAR(500)  NULL,
        INTERVALO_MINUTOS   INT            NOT NULL CONSTRAINT DF_PHF_CONFIG_INTERVALO DEFAULT 15,
        ULTIMO_ESCANEO      DATETIME2      NULL,
        ULTIMO_RESULTADO    NVARCHAR(500)  NULL,
        CONSTRAINT PK_PHF_CONFIGURACION PRIMARY KEY (ID),
        CONSTRAINT CK_PHF_CONFIGURACION_ID CHECK (ID = 1)
      );
    `,
  },
]

/**
 * Todos los nombres de tabla, constraint e indice de las DEFINICIONES
 * contienen la substring "PHF_" (tabla, PK, FK, DF, CK, IX...), asi que un
 * reemplazo global de esa substring alcanza para renombrar todo de forma
 * consistente -- incluidas las referencias FK entre tablas propias -- sin
 * que un prefijo de prueba distinto choque nunca con un nombre real de la
 * base productiva.
 */
function conPrefijo(texto: string, prefijo: string): string {
  return texto.replaceAll('PHF_', prefijo)
}

async function existeTabla(pool: sql.ConnectionPool, tabla: string): Promise<boolean> {
  const r = await pool
    .request()
    .input('t', tabla)
    .query('SELECT COUNT(*) AS n FROM sys.tables WHERE name = @t')
  return r.recordset[0].n > 0
}

/** Nombres, de entre `indicesEsperados`, que no existen todavia en `tabla`. */
async function indicesFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  indicesEsperados: string[],
): Promise<string[]> {
  if (indicesEsperados.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = indicesEsperados.map((nombre, i) => {
    req.input(`i${i}`, nombre)
    return `@i${i}`
  })
  const r = await req.query(`
    SELECT i.name AS nombre
    FROM sys.indexes i
    JOIN sys.tables t ON t.object_id = i.object_id
    WHERE t.name = @t AND i.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return indicesEsperados.filter((n) => !presentes.has(n))
}

/** Nombres, de entre `columnasEsperadas`, que no existen todavia en `tabla`. */
async function columnasFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  columnasEsperadas: string[],
): Promise<string[]> {
  if (columnasEsperadas.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = columnasEsperadas.map((nombre, i) => {
    req.input(`c${i}`, nombre)
    return `@c${i}`
  })
  const r = await req.query(`
    SELECT c.name AS nombre
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    WHERE t.name = @t AND c.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return columnasEsperadas.filter((n) => !presentes.has(n))
}

/** Nombres, de entre `checksEsperados`, que no existen todavia en `tabla`. */
async function checksFaltantes(
  pool: sql.ConnectionPool,
  tabla: string,
  checksEsperados: string[],
): Promise<string[]> {
  if (checksEsperados.length === 0) return []

  const req = pool.request().input('t', tabla)
  const placeholders = checksEsperados.map((nombre, i) => {
    req.input(`k${i}`, nombre)
    return `@k${i}`
  })
  const r = await req.query(`
    SELECT cc.name AS nombre
    FROM sys.check_constraints cc
    JOIN sys.tables t ON t.object_id = cc.parent_object_id
    WHERE t.name = @t AND cc.name IN (${placeholders.join(', ')})
  `)
  const presentes = new Set(r.recordset.map((row: { nombre: string }) => row.nombre))
  return checksEsperados.filter((n) => !presentes.has(n))
}

/**
 * Crea las tablas que falten y repara, en las que ya existen, las columnas,
 * los indices y los CHECK constraints que falten. Para una tabla ausente,
 * CREATE TABLE + todos sus CREATE INDEX corren en una sola transaccion: si
 * el CREATE TABLE pasa pero un CREATE INDEX del mismo batch falla, el
 * rollback se lleva puesta tambien la tabla, para que la proxima corrida
 * la vuelva a intentar completa en vez de saltearla para siempre por el
 * chequeo de idempotencia.
 * Para una tabla que ya existe pero le faltan columnas, indices y/o
 * checks, nunca se reintenta el CREATE TABLE -- se emiten *solo* los
 * ALTER TABLE ADD, CREATE INDEX y ALTER TABLE ADD CONSTRAINT faltantes,
 * en ese orden (columnas primero, porque un indice o un check futuro
 * podria apoyarse en una columna nueva). Devuelve los nombres de las
 * tablas creadas (no las reparadas).
 */
export async function migrarDefiniciones(
  definiciones: Definicion[],
  prefijo = 'PHF_',
): Promise<string[]> {
  const pool = await getPool()
  const creadas: string[] = []

  for (const { tabla: tablaBase, ddlTabla, indices, columnas, checks } of definiciones) {
    const tabla = conPrefijo(tablaBase, prefijo)
    const indicesDef = (indices ?? []).map((i) => ({
      nombre: conPrefijo(i.nombre, prefijo),
      ddl: conPrefijo(i.ddl, prefijo),
    }))

    if (!(await existeTabla(pool, tabla))) {
      await conTransaccion(async (tx) => {
        const ddlCompleto = [conPrefijo(ddlTabla, prefijo), ...indicesDef.map((i) => i.ddl)].join('\n')
        await tx.request().batch(ddlCompleto)
      })
      creadas.push(tabla)
      continue
    }

    const columnasDef = (columnas ?? []).map((x) => ({
      nombre: conPrefijo(x.nombre, prefijo),
      ddl: conPrefijo(x.ddl, prefijo),
    }))

    // Las columnas van antes que los indices: un indice futuro podria
    // apoyarse en una columna nueva.
    const colFaltantes = await columnasFaltantes(
      pool,
      tabla,
      columnasDef.map((x) => x.nombre),
    )
    if (colFaltantes.length > 0) {
      await conTransaccion(async (tx) => {
        // Un solo ADD con todas: SQL Server lo resuelve en una pasada, y
        // asi no queda una tabla a medio migrar si falla la tercera.
        const lista = columnasDef
          .filter((x) => colFaltantes.includes(x.nombre))
          .map((x) => x.ddl)
          .join(', ')
        await tx.request().batch(`ALTER TABLE ${tabla} ADD ${lista}`)
      })
    }

    const faltantes = await indicesFaltantes(
      pool,
      tabla,
      indicesDef.map((i) => i.nombre),
    )
    if (faltantes.length > 0) {
      await conTransaccion(async (tx) => {
        const ddlIndicesFaltantes = indicesDef
          .filter((i) => faltantes.includes(i.nombre))
          .map((i) => i.ddl)
          .join('\n')
        await tx.request().batch(ddlIndicesFaltantes)
      })
    }

    const checksDef = (checks ?? []).map((c) => ({
      nombre: conPrefijo(c.nombre, prefijo),
      ddl: conPrefijo(c.ddl, prefijo),
      reemplazaA: (c.reemplazaA ?? []).map((n) => conPrefijo(n, prefijo)),
    }))
    const checksQueFaltan = await checksFaltantes(
      pool,
      tabla,
      checksDef.map((c) => c.nombre),
    )
    if (checksQueFaltan.length > 0) {
      await conTransaccion(async (tx) => {
        for (const c of checksDef) {
          if (!checksQueFaltan.includes(c.nombre)) continue
          for (const viejo of c.reemplazaA) {
            await tx.request().batch(`
              IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = '${viejo}')
                ALTER TABLE ${tabla} DROP CONSTRAINT ${viejo};
            `)
          }
          await tx.request().batch(c.ddl)
        }
      })
    }
  }

  return creadas
}

/**
 * A diferencia del resto de las tablas propias, que arrancan vacias,
 * PHF_CONFIGURACION necesita su unica fila (ID=1) sembrada desde el vamos --
 * sin eso no hay de donde leer INTERVALO_MINUTOS. Ninguna otra tabla
 * necesita esto hoy, asi que es un paso puntual y no un campo mas de
 * `Definicion` (YAGNI).
 */
async function sembrarConfiguracion(prefijo: string): Promise<void> {
  const pool = await getPool()
  const tabla = conPrefijo('PHF_CONFIGURACION', prefijo)
  await pool.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM ${tabla} WHERE ID = 1)
      INSERT INTO ${tabla} (ID, INTERVALO_MINUTOS) VALUES (1, 15);
  `)
}

/** Crea las tablas propias que falten y repara las que ya existen. Devuelve los nombres de las creadas. */
export async function migrar(prefijo = 'PHF_'): Promise<string[]> {
  const creadas = await migrarDefiniciones(DEFINICIONES, prefijo)
  await sembrarConfiguracion(prefijo)
  return creadas
}

// Deteccion de ejecucion directa (vs. import desde los tests). Comparar
// contra process.argv[1] con string matching es fragil entre shells de
// Windows (backslashes vs. forward slashes, rutas relativas, resolucion
// distinta segun el invocador). path.resolve() normaliza ambos lados al
// mismo formato de ruta de sistema de archivos antes de comparar.
function esEjecucionDirecta(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  try {
    const esteArchivo = path.resolve(fileURLToPath(import.meta.url))
    const scriptInvocado = path.resolve(argv1)
    return esteArchivo === scriptInvocado
  } catch {
    return false
  }
}

if (esEjecucionDirecta()) {
  migrar()
    .then((creadas) => {
      if (creadas.length === 0) console.log('Esquema al dia, no habia nada que crear.')
      else console.log(`Tablas creadas: ${creadas.join(', ')}`)
    })
    .catch((err) => {
      console.error('Fallo la migracion:', err.message)
      process.exitCode = 1
    })
    .finally(() => cerrarPool())
}
