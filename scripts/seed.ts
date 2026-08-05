import { config as cargarEnv } from 'dotenv'
import sql from 'mssql'
import { getPool, cerrarPool } from '../src/server/db/pool'

cargarEnv({ path: '.env.local' })

const MUESTRAS = [
  { estado: 'leido',       tipo: 'FAC A', pv: '0003', nro: '0003-00018742', razon: 'DISTRIBUIDORA NORTE SA',    cuit: '30648729137', total: 1284500.5,  conf: 0.96 },
  { estado: 'leido',       tipo: 'FAC A', pv: '0007', nro: '0007-00000912', razon: 'METALURGICA DEL SUR SRL',   cuit: '30112223334', total: 486320.0,   conf: 0.78 },
  { estado: 'observacion', tipo: 'FAC B', pv: '0001', nro: '0001-00004411', razon: 'PAPELERA CENTRO SA',        cuit: '33556667778', total: 92150.75,   conf: 0.88 },
  { estado: 'confirmado',  tipo: 'FAC A', pv: '0012', nro: '0012-00033201', razon: 'INSUMOS INDUSTRIALES SRL',  cuit: '30777888990', total: 2310000.0,  conf: 0.99 },
  { estado: 'registrado',  tipo: 'FAC A', pv: '0005', nro: '0005-00071044', razon: 'TRANSPORTE ANDINO SA',      cuit: '30999111223', total: 154800.0,   conf: 1 },
  { estado: 'error',       tipo: null,    pv: null,   nro: null,            razon: null,                        cuit: null,          total: null,       conf: null },
]

async function sembrar() {
  const pool = await getPool()
  for (const m of MUESTRAS) {
    await pool
      .request()
      .input('nombre', sql.NVarChar(260), `muestra-${m.nro ?? 'ilegible'}.pdf`)
      .input('ruta', sql.NVarChar(500), 'muestra')
      .input('hash', sql.Char(64), '0'.repeat(64))
      .input('estado', sql.VarChar(20), m.estado)
      .input('tipo', sql.VarChar(10), m.tipo)
      .input('pv', sql.VarChar(10), m.pv)
      .input('nro', sql.VarChar(20), m.nro)
      .input('fecha', sql.Date, new Date())
      .input('razon', sql.NVarChar(200), m.razon)
      .input('cuit', sql.VarChar(15), m.cuit)
      .input('total', sql.Decimal(19, 4), m.total)
      .input('conf', sql.Decimal(5, 4), m.conf)
      .input('reg', sql.DateTime2, m.estado === 'registrado' ? new Date() : null)
      .query(`
        INSERT INTO PHF_COMPROBANTE
          (ARCHIVO_NOMBRE, ARCHIVO_RUTA, ARCHIVO_HASH, ESTADO, TIPO, PUNTO_VENTA, NUMERO,
           FECHA_EMISION, RAZON_SOCIAL, CUIT, TOTAL, CONFIANZA_PROMEDIO, FECHA_REGISTRO, USUARIO_ALTA)
        VALUES (@nombre, @ruta, @hash, @estado, @tipo, @pv, @nro,
                @fecha, @razon, @cuit, @total, @conf, @reg, 'seed')
      `)
  }
  console.log(`Sembrados ${MUESTRAS.length} comprobantes de muestra.`)
}

sembrar()
  .catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
  .finally(() => cerrarPool())
