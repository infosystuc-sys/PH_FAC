import { describe, it, expect } from 'vitest'
import {
  ACCEPT_ARCHIVOS,
  tipoPorNombre,
  tipoPorMime,
  tipoPorContenido,
  esImagen,
} from '@/lib/tipoArchivo'

// Desde el 2026-09-16 se admiten JPG y PNG ademas de PDF (pedido del
// usuario): hay comprobantes que llegan como foto o como escaneo en imagen.
describe('tipoArchivo', () => {
  it('reconoce por extension, sin importar mayusculas', () => {
    expect(tipoPorNombre('factura.pdf')).toBe('pdf')
    expect(tipoPorNombre('FOTO.JPG')).toBe('jpeg')
    expect(tipoPorNombre('escaneo.jpeg')).toBe('jpeg')
    expect(tipoPorNombre('escaneo.png')).toBe('png')
    expect(tipoPorNombre('planilla.xlsx')).toBeNull()
    expect(tipoPorNombre('sin_extension')).toBeNull()
  })

  it('reconoce por MIME', () => {
    expect(tipoPorMime('application/pdf')).toBe('pdf')
    expect(tipoPorMime('image/jpeg')).toBe('jpeg')
    expect(tipoPorMime('image/png')).toBe('png')
    expect(tipoPorMime('')).toBeNull()
    expect(tipoPorMime('image/gif')).toBeNull()
  })

  it('reconoce por los primeros bytes, que es lo que manda', () => {
    // Ni el nombre ni el MIME del navegador son de fiar: un ".pdf" que es una
    // imagen renombrada existe, y el modelo rechaza un `document` que no sea
    // PDF de verdad.
    expect(tipoPorContenido(Buffer.from('%PDF-1.4 blah blah'))).toBe('pdf')
    expect(tipoPorContenido(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('jpeg')
    expect(tipoPorContenido(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png')
    expect(tipoPorContenido(Buffer.from('hola mundo, esto no es nada'))).toBeNull()
    expect(tipoPorContenido(Buffer.from('%PD'))).toBeNull()
  })

  it('el accept del input lista MIME y extensiones de los tres', () => {
    for (const x of ['application/pdf', '.pdf', 'image/jpeg', '.jpg', '.jpeg', 'image/png', '.png']) {
      expect(ACCEPT_ARCHIVOS.split(',')).toContain(x)
    }
  })

  it('distingue imagen de PDF', () => {
    expect(esImagen('pdf')).toBe(false)
    expect(esImagen('jpeg')).toBe(true)
    expect(esImagen('png')).toBe(true)
  })
})
