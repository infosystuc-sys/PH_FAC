import { describe, it, expect } from 'vitest'
import {
  cotejarRenglones,
  describirDiferencias,
  type LineaRemito,
  type RenglonFacturado,
} from '@/lib/cotejo'

/** Un remito de dos renglones, como el promedio real (3,8 por remito). */
const REMITO: LineaRemito[] = [
  {
    indice: 1,
    codArticulo: '106362',
    descripcion: 'TENDER ONE BOX',
    cantidad: 20,
    numeroRemito: 'R0000200006818',
  },
  {
    indice: 2,
    codArticulo: '106742',
    descripcion: 'SOPORTE TV FIJO',
    cantidad: 6,
    numeroRemito: 'R0000200006818',
  },
]

function facturado(lineaRemito: number, cantidad: string, descripcion = 'x'): RenglonFacturado {
  return { lineaRemito, descripcion, cantidad, precioUnitario: '100,00', bonificacion: null, codigoProveedor: null }
}

describe('cotejarRenglones', () => {
  it('no reporta nada cuando la factura cubre el remito exacto', () => {
    const d = cotejarRenglones([facturado(1, '20'), facturado(2, '6')], REMITO)
    expect(d).toEqual([])
  })

  it('detecta que facturan mas cantidad de la entregada', () => {
    const d = cotejarRenglones([facturado(1, '24'), facturado(2, '6')], REMITO)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ tipo: 'cantidad', cantidadRemito: 20, cantidadFacturada: 24 })
  })

  it('detecta que facturan menos: la factura cubre el remito entero', () => {
    // Con parcialidad permitida esto seria valido, pero la norma del
    // usuario es que la factura cubre el remito completo.
    const d = cotejarRenglones([facturado(1, '15'), facturado(2, '6')], REMITO)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ tipo: 'cantidad', cantidadFacturada: 15 })
  })

  it('detecta un renglon del remito que la factura no cobra', () => {
    const d = cotejarRenglones([facturado(1, '20')], REMITO)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ tipo: 'falta-en-factura' })
    if (d[0].tipo === 'falta-en-factura') expect(d[0].linea.codArticulo).toBe('106742')
  })

  it('detecta un renglon facturado que no esta en el remito', () => {
    const extra: RenglonFacturado = {
      lineaRemito: 0,
      descripcion: 'FLETE',
      cantidad: '1',
      precioUnitario: '5.000,00',
      bonificacion: null, codigoProveedor: null
    }
    const d = cotejarRenglones([facturado(1, '20'), facturado(2, '6'), extra], REMITO)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ tipo: 'no-esta-en-remito', descripcion: 'FLETE' })
  })

  it('trata como no-esta-en-remito un indice que no existe', () => {
    // La IA no deberia inventar un indice fuera de rango, pero si lo hace
    // no puede colarse como si estuviera emparejado.
    const d = cotejarRenglones([facturado(1, '20'), facturado(2, '6'), facturado(9, '1')], REMITO)
    expect(d).toHaveLength(1)
    expect(d[0].tipo).toBe('no-esta-en-remito')
  })

  it('suma las lineas que apuntan al mismo renglon del remito', () => {
    // Un proveedor puede partir un articulo en dos lineas (por talle, por
    // lote). Si la suma da, la cantidad esta bien: solo se avisa que esta
    // repetido, no que hay diferencia.
    const d = cotejarRenglones(
      [facturado(1, '12'), facturado(1, '8'), facturado(2, '6')],
      REMITO,
    )
    expect(d.filter((x) => x.tipo === 'cantidad')).toEqual([])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ tipo: 'repetido', veces: 2 })
  })

  it('reporta cantidad y repetido cuando la suma tampoco da', () => {
    const d = cotejarRenglones(
      [facturado(1, '12'), facturado(1, '2'), facturado(2, '6')],
      REMITO,
    )
    expect(d.map((x) => x.tipo)).toEqual(['cantidad', 'repetido'])
  })

  it('tolera el redondeo de las cantidades decimales', () => {
    // Vienen de parsear texto de un PDF contra una columna DECIMAL(19,4).
    const conDecimales: LineaRemito[] = [{ ...REMITO[0], cantidad: 1.5 }]
    expect(cotejarRenglones([facturado(1, '1,5')], conDecimales)).toEqual([])
    expect(cotejarRenglones([facturado(1, '1,50001')], conDecimales)).toEqual([])
    expect(cotejarRenglones([facturado(1, '1,6')], conDecimales)).toHaveLength(1)
  })

  it('una factura vacia reporta todos los renglones del remito como faltantes', () => {
    const d = cotejarRenglones([], REMITO)
    expect(d).toHaveLength(2)
    expect(d.every((x) => x.tipo === 'falta-en-factura')).toBe(true)
  })

  it('ordena primero las diferencias de cantidad y ultimo lo que sobra', () => {
    const extra: RenglonFacturado = {
      lineaRemito: 0,
      descripcion: 'FLETE',
      cantidad: '1',
      precioUnitario: null,
      bonificacion: null, codigoProveedor: null
    }
    const d = cotejarRenglones([facturado(1, '24'), extra], REMITO)
    expect(d.map((x) => x.tipo)).toEqual(['cantidad', 'falta-en-factura', 'no-esta-en-remito'])
  })
})

describe('describirDiferencias', () => {
  it('nombra el articulo, el remito y las dos cantidades', () => {
    const d = cotejarRenglones([facturado(1, '24'), facturado(2, '6')], REMITO)
    const texto = describirDiferencias(d)[0]

    expect(texto).toContain('106362')
    expect(texto).toContain('TENDER ONE BOX')
    expect(texto).toContain('R0000200006818')
    expect(texto).toContain('20')
    expect(texto).toContain('24')
  })

  it('escribe las cantidades con coma y sin ceros de relleno', () => {
    const conDecimales: LineaRemito[] = [{ ...REMITO[0], cantidad: 1.5 }]
    const d = cotejarRenglones([facturado(1, '2,25')], conDecimales)
    const texto = describirDiferencias(d)[0]
    expect(texto).toContain('1,5')
    expect(texto).toContain('2,25')
  })

  it('describe los cuatro tipos sin romperse con descripciones vacias', () => {
    const sinDesc: LineaRemito[] = [{ ...REMITO[0], descripcion: null }]
    const d = cotejarRenglones(
      [
        { lineaRemito: 1, descripcion: null, cantidad: '5', precioUnitario: null, bonificacion: null, codigoProveedor: null },
        { lineaRemito: 1, descripcion: null, cantidad: '5', precioUnitario: null, bonificacion: null, codigoProveedor: null },
        { lineaRemito: 0, descripcion: null, cantidad: '1', precioUnitario: null, bonificacion: null, codigoProveedor: null },
      ],
      sinDesc,
    )
    const textos = describirDiferencias(d)
    expect(textos).toHaveLength(3)
    for (const t of textos) expect(t).not.toContain('null')
  })
})
