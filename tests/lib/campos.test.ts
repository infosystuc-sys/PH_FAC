import { describe, it, expect } from 'vitest'
import {
  CAMPOS,
  CAMPOS_IA,
  esClaveValida,
  campoPorClave,
  schemaExtraccion,
  camposIaPara,
} from '@/lib/campos'
import {
  CAMPOS_NO_ANALIZADOS,
  ANALIZA_RENGLONES,
  MAX_CAMPOS_SIN_RENGLONES,
  MAX_CAMPOS_CON_RENGLONES,
  TIPOS_FACTURA,
  analizaCampo,
  spanDe,
} from '@/lib/tipoFactura'

describe('catalogo de campos', () => {
  it('no repite claves', () => {
    const claves = CAMPOS.map((c) => c.clave)
    expect(new Set(claves).size).toBe(claves.length)
  })

  it('ninguna clave supera los 40 caracteres de PHF_CAMPO.CLAVE', () => {
    for (const c of CAMPOS) expect(c.clave.length).toBeLessThanOrEqual(40)
  })

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'en %s cada grupo suma un multiplo de 6, el ancho de la grilla',
    (tipo) => {
    // Por tipo y no una sola vez: cada tipo oculta campos distintos (ver
    // CAMPOS_NO_ANALIZADOS) y sacar uno de un grupo lo descuadra. Los que
    // quedan se reacomodan con spanDe; esto verifica que la cuenta cierre
    // igual en los tres.
    const porGrupo = new Map<string, number>()
    for (const c of CAMPOS) {
      if (!analizaCampo(tipo, c.clave) && c.extraePorIA) continue
      porGrupo.set(c.grupo, (porGrupo.get(c.grupo) ?? 0) + spanDe(tipo, c.clave, c.span))
    }

    // Las filas de IVA y de percepcion ya tienen su celda del medio en el
    // catalogo (codivaN / codpercepN): la pinta el formulario en vez del
    // bucle, pero el span esta contado. La de "impuestos varios" no tiene
    // contrapartida en el catalogo -- ahi la lista esta en la columna 1 y
    // la del medio es solo confirmacion -- asi que se suma aparte, o el
    // invariante dejaria de describir lo que el operador ve.
    const derivadasVarios = CAMPOS.filter((c) => /^varios[12]$/.test(c.clave)).length * 2
    porGrupo.set('importes', (porGrupo.get('importes') ?? 0) + derivadasVarios)

    // Al lado del codigo de proveedor va el concepto que Tango le tiene
    // asociado. Sale del ERP, no se guarda en PHF_CAMPO, y lo pinta el
    // formulario -- pero ocupa media fila igual.
    porGrupo.set('proveedor', (porGrupo.get('proveedor') ?? 0) + 3)

    for (const [grupo, ancho] of porGrupo) {
      expect(ancho % 6, `en ${tipo} el grupo ${grupo} suma ${ancho}`).toBe(0)
    }
    },
  )

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    '%s no analiza los ocho campos que no se imputan',
    (tipo) => {
      const claves = camposIaPara(tipo).map((c) => c.clave)
      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(claves, `${tipo} no deberia analizar ${excluido}`).not.toContain(excluido)
      }
      expect(claves).toHaveLength(39 - CAMPOS_NO_ANALIZADOS[tipo].length)

      // Todos siguen en el catalogo: la IA no los lee, pero el operador
      // puede tener uno cargado a mano de antes y el formulario tiene que
      // saber mostrarlo.
      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(campoPorClave(excluido), `${excluido} salio del catalogo`).toBeTruthy()
      }
    },
  )

  it('la IA extrae 39 campos', () => {
    // El numero exacto es un tripwire, no una formalidad: la API ya rechazo
    // este schema dos veces por tamaño -- una por superar las 16 uniones de
    // tipos, otra por "compiled grammar is too large" con 29 campos
    // anidados. La forma aplanada aguanto 29; ahora son 39. Si este test
    // salta al agregar campos, hay que verificar contra la API real antes
    // de dar por hecho que el schema sigue entrando. Conceptos pide 31 --
    // ver camposIaPara -- asi que el peor caso son los otros dos tipos.
    expect(CAMPOS_IA.length).toBe(39)
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

  it('los impuestos varios son selects que la IA sugiere', () => {
    expect(campoPorClave('varios1')?.tipo).toBe('select')
    expect(campoPorClave('varios1')?.extraePorIA).toBe(true)
  })

  it('tipoFactura es un campo de tipo select', () => {
    expect(campoPorClave('tipoFactura')?.tipo).toBe('select')
  })
})

describe('schemaExtraccion', () => {
  it('pide exactamente los campos que extrae la IA, en valores y en confianzas', () => {
    const s = schemaExtraccion('articulos') as any
    const claves = camposIaPara('articulos').map((c) => c.clave).sort()

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
    recorrer(schemaExtraccion('articulos'))
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
    const s = schemaExtraccion('articulos') as any
    expect(s.properties.valores.properties.cuit).toEqual({ type: 'string' })
    expect(s.properties.confianzas.properties.cuit.type).toBe('number')
  })

  it('aplana valores y confianzas en vez de anidar un objeto por campo', () => {
    // Con 29 campos anidados en {valor, confianza} la API rechazo el
    // schema real con "compiled grammar is too large" -- 29 objetos
    // gramaticales de dos props pesan mucho mas que dos objetos de 29
    // props cada uno. La forma aplanada no cambia la semantica (misma
    // convencion de cadena vacia, mismas claves), solo la anidacion.
    const s = schemaExtraccion('articulos') as any
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
    recorrer(schemaExtraccion('articulos'))
    expect(uniones).toEqual([])
  })

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'en %s no pide renglones ni los campos excluidos',
    (tipo) => {
      // No es que el array venga vacio: no esta en el schema. Con structured
      // outputs eso es una garantia, no una instruccion que el modelo pueda
      // desoir. Ver ANALIZA_RENGLONES: de los comprobantes solo se leen
      // subtotales, totales e impuestos.
      const s = schemaExtraccion(tipo) as any
      expect(ANALIZA_RENGLONES[tipo]).toBe(false)
      expect(s.properties.renglones).toBeUndefined()
      expect(s.required).not.toContain('renglones')

      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(s.properties.valores.properties[excluido]).toBeUndefined()
        expect(s.properties.confianzas.properties[excluido]).toBeUndefined()
      }
    },
  )

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'el schema de %s entra bajo el techo medido contra la API',
    (tipo) => {
      // El techo real (35 campos sin el array de renglones, 31 con el) esta
      // medido, no estimado -- ver MAX_CAMPOS_* y scripts/verificar-schema.ts.
      // Este test es lo mas cerca que se puede estar de esa verificacion sin
      // pegarle a la API: si salta, correr el script antes de dar por hecho
      // que el schema sigue entrando.
      const techo = ANALIZA_RENGLONES[tipo] ? MAX_CAMPOS_CON_RENGLONES : MAX_CAMPOS_SIN_RENGLONES
      expect(camposIaPara(tipo).length).toBeLessThanOrEqual(techo)
    },
  )
})
