import { describe, it, expect, afterAll } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { guardarPdf, leerPdf, directorioStorage } from '@/server/app/archivos'

const creados: string[] = []

afterAll(async () => {
  for (const r of creados) await rm(r, { force: true })
})

describe('guardarPdf', () => {
  it('guarda el archivo y devuelve su hash sha-256', async () => {
    const datos = Buffer.from('%PDF-1.4 contenido de prueba')
    const { ruta, hash } = await guardarPdf('factura.pdf', datos)
    creados.push(ruta)

    expect(hash).toBe(createHash('sha256').update(datos).digest('hex'))
    expect(hash).toHaveLength(64)
    expect(await leerPdf(ruta)).toEqual(datos)
  })

  it('no pisa un archivo anterior con el mismo nombre', async () => {
    const a = await guardarPdf('igual.pdf', Buffer.from('primero'))
    const b = await guardarPdf('igual.pdf', Buffer.from('segundo'))
    creados.push(a.ruta, b.ruta)

    expect(a.ruta).not.toBe(b.ruta)
    expect((await leerPdf(a.ruta)).toString()).toBe('primero')
    expect((await leerPdf(b.ruta)).toString()).toBe('segundo')
  })

  it('no deja que el nombre del archivo escape del directorio', async () => {
    const { ruta } = await guardarPdf('../../evadido.pdf', Buffer.from('x'))
    creados.push(ruta)
    expect(ruta.startsWith(directorioStorage())).toBe(true)
    expect(ruta).not.toContain('..')
  })

  it('conserva la extension pdf aunque el nombre venga sin ella', async () => {
    const { ruta } = await guardarPdf('sin_extension', Buffer.from('x'))
    creados.push(ruta)
    expect(ruta.endsWith('.pdf')).toBe(true)
  })
})
