import { describe, it, expect } from 'vitest'
import {
  CAMPOS,
  CAMPOS_IA,
  esClaveValida,
  campoPorClave,
  schemaExtraccion,
} from '@/lib/campos'

describe('catalogo de campos', () => {
  it('no repite claves', () => {
    const claves = CAMPOS.map((c) => c.clave)
    expect(new Set(claves).size).toBe(claves.length)
  })

  it('ninguna clave supera los 40 caracteres de PHF_CAMPO.CLAVE', () => {
    for (const c of CAMPOS) expect(c.clave.length).toBeLessThanOrEqual(40)
  })

  it('cada grupo suma un multiplo de 6, el ancho de la grilla', () => {
    const porGrupo = new Map<string, number>()
    for (const c of CAMPOS) porGrupo.set(c.grupo, (porGrupo.get(c.grupo) ?? 0) + c.span)
    for (const [grupo, ancho] of porGrupo) {
      expect(ancho % 6, `el grupo ${grupo} suma ${ancho}`).toBe(0)
    }
  })

  it('la IA extrae 29 campos', () => {
    expect(CAMPOS_IA.length).toBe(29)
  })

  it('los campos calculados y de imputacion no los extrae la IA', () => {
    for (const clave of ['imputado', 'codprovee', 'condcompra']) {
      expect(campoPorClave(clave)!.extraePorIA).toBe(false)
    }
  })

  it('reconoce una clave del catalogo y rechaza una inventada', () => {
    expect(esClaveValida('cuit')).toBe(true)
    expect(esClaveValida('no_existe')).toBe(false)
  })

  it('condcompra es un campo de tipo select', () => {
    expect(campoPorClave('condcompra')?.tipo).toBe('select')
  })
})

describe('schemaExtraccion', () => {
  it('pide exactamente los campos que extrae la IA, en valores y en confianzas', () => {
    const s = schemaExtraccion() as any
    const claves = CAMPOS_IA.map((c) => c.clave).sort()

    const propsValores = Object.keys(s.properties.valores.properties)
    expect(propsValores.sort()).toEqual(claves)
    expect(s.properties.valores.required.sort()).toEqual(claves)

    const propsConfianzas = Object.keys(s.properties.confianzas.properties)
    expect(propsConfianzas.sort()).toEqual(claves)
    expect(s.properties.confianzas.required.sort()).toEqual(claves)
  })

  it('cierra todos los objetos con additionalProperties false', () => {
    // Structured outputs lo exige en cada objeto del schema.
    const objetos: any[] = []
    const recorrer = (n: any) => {
      if (n === null || typeof n !== 'object') return
      if (n.type === 'object') objetos.push(n)
      for (const v of Object.values(n)) recorrer(v)
    }
    recorrer(schemaExtraccion())
    expect(objetos.length).toBeGreaterThan(0)
    for (const o of objetos) expect(o.additionalProperties).toBe(false)
  })

  it('modela el valor ausente con cadena vacia, no con union de tipos', () => {
    // Antes esto era `anyOf: [{type:'string'},{type:'null'}]`. Con 21 campos
    // mas 5 claves de renglon esa union suma 26 parametros -- structured
    // outputs rechaza el schema por encima de 16 uniones (400,
    // "too many parameters with union types"). La cadena vacia hace el
    // mismo trabajo sin sumar una union: parsearRespuesta la traduce a
    // null via su helper texto().
    const s = schemaExtraccion() as any
    expect(s.properties.valores.properties.cuit).toEqual({ type: 'string' })
    expect(s.properties.confianzas.properties.cuit.type).toBe('number')
  })

  it('aplana valores y confianzas en vez de anidar un objeto por campo', () => {
    // Con 29 campos anidados en {valor, confianza} la API rechazo el
    // schema real con "compiled grammar is too large" -- 29 objetos
    // gramaticales de dos props pesan mucho mas que dos objetos de 29
    // props cada uno. La forma aplanada no cambia la semantica (misma
    // convencion de cadena vacia, mismas claves), solo la anidacion.
    const s = schemaExtraccion() as any
    expect(s.properties.campos).toBeUndefined()
    expect(s.properties.valores.type).toBe('object')
    expect(s.properties.confianzas.type).toBe('object')
  })

  it('no supera el limite de 16 uniones de tipos que exige structured outputs', () => {
    // Regresion: ninguna rama del schema puede tener `anyOf`, `oneOf`,
    // `allOf` ni `type` como array. Si esto vuelve a aparecer, la API
    // rechaza el request entero con 400 antes de llegar al modelo.
    const uniones: unknown[] = []
    const recorrer = (n: unknown) => {
      if (n === null || typeof n !== 'object') return
      const o = n as Record<string, unknown>
      if ('anyOf' in o) uniones.push(o.anyOf)
      if ('oneOf' in o) uniones.push(o.oneOf)
      if ('allOf' in o) uniones.push(o.allOf)
      if (Array.isArray(o.type)) uniones.push(o.type)
      for (const v of Object.values(o)) recorrer(v)
    }
    recorrer(schemaExtraccion())
    expect(uniones).toEqual([])
  })

  it('pide los cinco datos de cada renglon', () => {
    const s = schemaExtraccion() as any
    expect(s.properties.renglones.items.required.sort()).toEqual(
      ['cantidad', 'codigo', 'descripcion', 'importe', 'precioUnitario'].sort(),
    )
  })
})
