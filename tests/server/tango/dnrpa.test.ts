import { describe, it, expect, afterAll } from 'vitest'
import sql from 'mssql'
import { cerrarPool } from '@/server/db/pool'
import { conRollback } from '@/server/db/tx'
import { filasDeSeriesEn, grabarDnrpaEn } from '@/server/tango/dnrpa'
import { aplicarDnrpaEn } from '@/server/app/dnrpa'

afterAll(async () => {
  await cerrarPool()
})

/**
 * Todo dentro de una transaccion que se revierte: STA06 y STA07 son datos
 * reales de Tango. Se usa una serie real que este en las dos tablas, y se le
 * deja el comentario "sin DNRPA" (la propia serie) dentro de la transaccion.
 */
async function serieReal(tx: sql.Transaction) {
  const r = await tx.request().query(`
    SELECT TOP 1 LTRIM(RTRIM(s6.N_SERIE)) AS serie, LTRIM(RTRIM(s6.COD_ARTICU)) AS art
    FROM STA06 s6
    WHERE EXISTS (SELECT 1 FROM STA07 s7 WHERE s7.N_SERIE = s6.N_SERIE AND s7.COD_ARTICU = s6.COD_ARTICU)
      AND NOT EXISTS (SELECT 1 FROM STA07 s7 WHERE s7.N_SERIE = s6.N_SERIE AND s7.COD_ARTICU <> s6.COD_ARTICU)
      AND s6.N_SERIE = UPPER(s6.N_SERIE) AND CHARINDEX(' ', LTRIM(RTRIM(s6.N_SERIE))) = 0
    ORDER BY s6.N_SERIE`)
  const f = r.recordset[0] as { serie: string; art: string } | undefined
  if (!f) return null
  for (const t of ['STA06', 'STA07']) {
    await tx.request().input('s', sql.VarChar(30), f.serie)
      .query(`UPDATE ${t} SET COMENTARIO = N_SERIE WHERE N_SERIE = @s`)
  }
  return f
}

async function comentarios(tx: sql.Transaction, serie: string) {
  const r = await tx.request().input('s', sql.VarChar(30), serie).query(`
    SELECT 'STA06' AS t, COMENTARIO FROM STA06 WHERE N_SERIE = @s
    UNION ALL SELECT 'STA07', COMENTARIO FROM STA07 WHERE N_SERIE = @s`)
  return r.recordset as { t: string; COMENTARIO: string }[]
}

describe('grabarDnrpaEn (2026-11-18)', () => {
  it('pone el DNRPA en STA06 y en todos los movimientos de STA07 de la serie', async () => {
    await conRollback(async (tx) => {
      const s = await serieReal(tx)
      expect(s).not.toBeNull()
      const antes = await comentarios(tx, s!.serie)

      const r = await grabarDnrpaEn(tx, [{ chasis: s!.serie, dnrpa: 'M-0000999999/2026' }])
      expect(r[0].clasificacion.estado).toBe('cargar')
      expect(r[0].sta06).toBe(antes.filter((x) => x.t === 'STA06').length)
      expect(r[0].sta07).toBe(antes.filter((x) => x.t === 'STA07').length)
      expect((await comentarios(tx, s!.serie)).every((x) => x.COMENTARIO === 'M-0000999999/2026')).toBe(true)

      // Otra vez con el mismo: ya lo tiene, no toca nada.
      const otraVez = await grabarDnrpaEn(tx, [{ chasis: s!.serie, dnrpa: 'M-0000999999/2026' }])
      expect(otraVez[0].clasificacion.estado).toBe('igual')
      expect(otraVez[0].sta06 + otraVez[0].sta07).toBe(0)
    })
  }, 60000)

  it('no pisa un comentario con otro dato', async () => {
    await conRollback(async (tx) => {
      const s = await serieReal(tx)
      expect(s).not.toBeNull()
      await tx.request().input('s', sql.VarChar(30), s!.serie)
        .query(`UPDATE STA06 SET COMENTARIO = 'M-0000000001/2026' WHERE N_SERIE = @s`)

      const r = await grabarDnrpaEn(tx, [{ chasis: s!.serie, dnrpa: 'M-0000999999/2026' }])
      expect(r[0].clasificacion.estado).toBe('otro')
      expect(r[0].sta06 + r[0].sta07).toBe(0)
      const c = await comentarios(tx, s!.serie)
      expect(c.some((x) => x.COMENTARIO === 'M-0000999999/2026')).toBe(false)
    })
  }, 60000)

  it('una serie que no esta en Tango se informa y no escribe nada', async () => {
    await conRollback(async (tx) => {
      const f = await filasDeSeriesEn(tx, ['ZZPHFNOEXISTE0001'])
      expect(f.get('ZZPHFNOEXISTE0001')).toEqual([])
      const r = await grabarDnrpaEn(tx, [{ chasis: 'ZZPHFNOEXISTE0001', dnrpa: 'M-0000999999/2026' }])
      expect(r[0].clasificacion.estado).toBe('no-encontrada')
    })
  }, 60000)

  it('aplicarDnrpaEn normaliza lo que llega y resume lo grabado', async () => {
    await conRollback(async (tx) => {
      const s = await serieReal(tx)
      expect(s).not.toBeNull()
      const resumen = await aplicarDnrpaEn(tx, [
        { chasis: ` ${s!.serie.toLowerCase()} `, dnrpa: ' m-0000999999/2026 ' },
        { chasis: 'ZZPHFNOEXISTE0001', dnrpa: 'M-0000999998/2026' },
      ])
      expect(resumen.cargadas).toBe(1)
      expect(resumen.filasSta06).toBeGreaterThan(0)
      expect(resumen.cambiaron).toEqual([{ chasis: 'ZZPHFNOEXISTE0001', estado: 'no-encontrada' }])
    })
  }, 60000)
})
