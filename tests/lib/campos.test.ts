import { describe, it, expect } from 'vitest'
import {
  CAMPOS,
  CAMPOS_IA,
  esClaveValida,
  campoPorClave,
  schemaExtraccion,
  camposIaPara,
  OCULTOS_EN_GRILLA,
} from '@/lib/campos'
import { LARGO_LEYENDA_COMPROBANTE } from '@/lib/validaciones'
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

    // Las tres familias -- IVA, percepcion y varios -- tienen su celda del
    // medio en el catalogo (codivaN / codpercepN / codvariosN): la pinta el
    // formulario en vez del bucle, pero el span esta contado. Los varios se
    // sumaron a este patron el 2026-09-04, al pasar `variosN` a guardar el
    // rotulo impreso en vez del codigo; hasta entonces su celda del medio no
    // existia en el catalogo y habia que sumarla aparte aca.

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
    '%s no analiza los campos que no se imputan en ese tipo',
    (tipo) => {
      const claves = camposIaPara(tipo).map((c) => c.clave)
      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(claves, `${tipo} no deberia analizar ${excluido}`).not.toContain(excluido)
      }
      expect(claves).toHaveLength(42 - CAMPOS_NO_ANALIZADOS[tipo].length)

      // Todos siguen en el catalogo: la IA no los lee, pero el operador
      // puede tener uno cargado a mano de antes y el formulario tiene que
      // saber mostrarlo.
      for (const excluido of CAMPOS_NO_ANALIZADOS[tipo]) {
        expect(campoPorClave(excluido), `${excluido} salio del catalogo`).toBeTruthy()
      }
    },
  )

  it('el catalogo tiene 42 campos que la IA puede llegar a extraer', () => {
    // El numero exacto es un tripwire, no una formalidad: la API ya rechazo
    // este schema tres veces por tamaño -- por superar las 16 uniones de
    // tipos, por "compiled grammar is too large" con 29 campos anidados, y
    // el 2026-09-08 al llevar articulos a 33 campos con el array (por eso
    // `leyendaAsiento` sale del schema de articulos y no de los otros dos).
    //
    // Ningun tipo pide los 42: cada uno saca los suyos (ver
    // CAMPOS_NO_ANALIZADOS). Hoy conceptos y articulos piden 32 y tarjeta
    // 26, y los tres los acepta la API -- medido, no deducido. Si este test
    // salta al agregar campos, corre scripts/verificar-schema.ts antes de
    // dar por hecho que el schema sigue entrando.
    expect(CAMPOS_IA.length).toBe(42)
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

  it('los impuestos varios siguen el patron de las percepciones: texto de la IA + codigo aparte', () => {
    // Hasta 2026-09-04 `variosN` era un select donde la IA sugeria el codigo
    // de Tango. No habia entonces ningun texto del comprobante contra el
    // cual aprender, asi que la eleccion del operador se perdia comprobante
    // a comprobante -- lo reporto el usuario con dos liquidaciones seguidas
    // de Tarjeta Naranja. Ahora `variosN` guarda el rotulo impreso, igual
    // que `percepN`, y el codigo elegido vive en `codvariosN`.
    expect(campoPorClave('varios1')?.tipo).toBe('texto')
    expect(campoPorClave('varios1')?.extraePorIA).toBe(true)

    expect(campoPorClave('codvarios1')?.extraePorIA).toBe(false)
    expect(campoPorClave('codvarios2')?.extraePorIA).toBe(false)
    // La pinta la celda del medio de su fila, no el bucle del formulario.
    expect(OCULTOS_EN_GRILLA.test('codvarios1')).toBe(true)
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

describe('maxLargo', () => {
  // La observacion va a CPA04.LEYENDA, que es varchar(30) -- la mas corta de
  // las dos columnas que la reciben (ASIENTO_CP.DESC_LEYENDA admite 100). El
  // tope se ve al escribir en vez de recortar el texto al grabar, adentro de
  // Tango, donde el operador ya no lo ve. Decision del usuario, 2026-09-08.
  it('la observacion se topea en el largo de CPA04.LEYENDA', () => {
    expect(campoPorClave('leyendaAsiento')?.maxLargo).toBe(LARGO_LEYENDA_COMPROBANTE)
    expect(LARGO_LEYENDA_COMPROBANTE).toBe(30)
  })

  it('ningun otro campo tiene tope: solo se pone donde la columna aprieta', () => {
    const conTope = CAMPOS.filter((c) => c.maxLargo !== undefined).map((c) => c.clave)
    expect(conTope).toEqual(['leyendaAsiento'])
  })
})

describe('siempreVisible', () => {
  // La anotacion manuscrita se lee en conceptos y tarjeta pero no en
  // articulos: ahi el schema no entra (medido contra la API el 2026-09-08,
  // 33 campos con el array devuelve "compiled grammar is too large"). El
  // campo tiene que seguir mostrandose igual, porque el operador tambien lo
  // escribe a mano -- si se escondiera, en articulos se quedaria sin donde.
  it('la observacion no se analiza en articulos pero sigue visible', () => {
    expect(analizaCampo('articulos', 'leyendaAsiento')).toBe(false)
    expect(analizaCampo('conceptos', 'leyendaAsiento')).toBe(true)
    expect(analizaCampo('tarjeta', 'leyendaAsiento')).toBe(true)
    expect(campoPorClave('leyendaAsiento')?.siempreVisible).toBe(true)
  })

  it('es el unico con la marca: el resto se esconde cuando no se analiza', () => {
    const visibles = CAMPOS.filter((c) => c.siempreVisible).map((c) => c.clave)
    expect(visibles).toEqual(['leyendaAsiento'])
  })
})
