import { describe, it, expect, afterAll } from 'vitest'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { guardarPdf, leerPdf, borrarPdf, directorioStorage } from '@/server/app/archivos'

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

  it('conserva la extension de una imagen, en minusculas como vino', async () => {
    // Desde el 2026-09-16 se admiten JPG y PNG. La extension guardada es la
    // que despues le dice al visor y a la API que es una imagen.
    const jpg = await guardarPdf('foto.JPG', Buffer.from('x'))
    creados.push(jpg.ruta)
    expect(jpg.ruta.toLowerCase().endsWith('.jpg')).toBe(true)
    expect(jpg.ruta.endsWith('.pdf')).toBe(false)
    const png = await guardarPdf('escaneo.png', Buffer.from('x'))
    creados.push(png.ruta)
    expect(png.ruta.endsWith('.png')).toBe(true)
  })

  it('rechaza traversal con backslash (Windows)', async () => {
    const { ruta } = await guardarPdf('..\\..\\evadido.pdf', Buffer.from('x'))
    creados.push(ruta)
    expect(ruta.startsWith(directorioStorage())).toBe(true)
    expect(ruta).not.toContain('..')
  })

  it('reemplaza nombres de dispositivo reservados de Windows', async () => {
    const casos = ['CON.pdf', 'prn.pdf', 'AUX.pdf', 'nul.pdf', 'com1.pdf', 'lpt9.pdf']
    for (const caso of casos) {
      const { ruta } = await guardarPdf(caso, Buffer.from('x'))
      creados.push(ruta)
      // El nombre del dispositivo debe ser reemplazado por "comprobante"
      const nombreArchivo = ruta.split(/[\\/]/).pop() || ''
      expect(nombreArchivo.toLowerCase()).toContain('comprobante.pdf')
    }
  })
})

describe('leerPdf', () => {
  it('lanza error si la ruta esta fuera del directorio', async () => {
    const { ruta } = await guardarPdf('valido.pdf', Buffer.from('contenido'))
    creados.push(ruta)

    // Intentar leer un archivo fuera del directorio. Desde 2026-10-27 se
    // busca su nombre adentro del storage --para las copias a otra PC--, y
    // ahi no hay ningun "passwd": falla igual, sin tocar el de afuera.
    const rutaFuera = '/etc/passwd'
    await expect(leerPdf(rutaFuera)).rejects.toThrow()
  })

  it('encuentra el archivo por su nombre cuando la ruta guardada es de otra PC', async () => {
    // La base copiada de produccion guarda C:\APP\PH_FAC\storage\...; en
    // esta instalacion el storage puede estar en otro lado.
    const { ruta } = await guardarPdf('copiado.pdf', Buffer.from('desde produccion'))
    creados.push(ruta)
    const nombre = ruta.split(/[\\/]/).pop()!
    const rutaDeOtraPc = `Z:\\otra\\instalacion\\storage\\${nombre}`

    expect((await leerPdf(rutaDeOtraPc)).toString()).toBe('desde produccion')
  })

  it('no sale del storage aunque el nombre guardado traiga ..', async () => {
    await expect(leerPdf('C:\\APP\\PH_FAC\\storage\\..')).rejects.toThrow()
  })
})

describe('borrarPdf', () => {
  it('borra el archivo del disco', async () => {
    const { ruta } = await guardarPdf('para-borrar.pdf', Buffer.from('%PDF-1.4 x'))
    await borrarPdf(ruta)
    await expect(leerPdf(ruta)).rejects.toThrow()
  })

  it('no falla si el archivo ya no esta', async () => {
    // Borrar el comprobante de la base es lo que importa. Que ademas falte
    // el PDF no puede hacer fallar la operacion entera y dejar al operador
    // resolviendo a mano algo que ya esta resuelto.
    const { ruta } = await guardarPdf('doble-borrado.pdf', Buffer.from('%PDF-1.4 x'))
    await borrarPdf(ruta)
    await expect(borrarPdf(ruta)).resolves.toBeUndefined()
  })

  it('rechaza una ruta fuera del directorio de comprobantes', async () => {
    // Un archivo faltante se tolera; una ruta que no deberiamos estar
    // borrando, no.
    await expect(borrarPdf('C:/Windows/System32/drivers/etc/hosts')).rejects.toThrow(/fuera del/i)
  })
})
