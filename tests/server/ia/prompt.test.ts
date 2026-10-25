import { describe, it, expect } from 'vitest'
import { PROMPTS_EXTRACCION } from '@/server/ia/prompt'
import { TIPOS_FACTURA, CAMPOS_NO_ANALIZADOS } from '@/lib/tipoFactura'
import { camposIaPara } from '@/lib/campos'
import { JURISDICCIONES_IIBB } from '@/lib/percepcionIibb'

// Los tipos que se imputan con importes: el remito no tiene impuestos, así
// que las reglas de IVA y percepciones no van en su prompt.
const CON_IMPUESTOS = TIPOS_FACTURA.filter((t) => t.clave !== 'remito')

describe('PROMPTS_EXTRACCION', () => {
  it('tiene un prompt por cada tipo de factura del catalogo', () => {
    for (const t of TIPOS_FACTURA) {
      expect(PROMPTS_EXTRACCION[t.clave], `falta el prompt de ${t.clave}`).toBeTruthy()
    }
    expect(Object.keys(PROMPTS_EXTRACCION)).toHaveLength(TIPOS_FACTURA.length)
  })

  it('los tres prompts son distintos entre si', () => {
    const textos = TIPOS_FACTURA.map((t) => PROMPTS_EXTRACCION[t.clave])
    expect(new Set(textos).size).toBe(textos.length)
  })

  it('el de articulos pide el detalle de renglones para cotejar contra la OC', () => {
    // Hasta 2026-09-06 se le pedia lo contrario --que NO los listara-- porque
    // el detalle salia del remito. Ahora las facturas de articulos se imputan
    // a una orden de compra y estos renglones son con lo que se cotejan.
    expect(PROMPTS_EXTRACCION.articulos).toContain('FACTURA DE ARTÍCULOS')
    expect(PROMPTS_EXTRACCION.articulos).toContain('renglones_pdf')
    // Desde el 2026-09-15 pide tambien el precio y el subtotal impresos: los
    // importes que valen son los de la factura (decision del usuario), y el
    // descuento global del pie hay que resolverlo contra ellos. La
    // descripcion se sumo el 2026-09-17.
    expect(PROMPTS_EXTRACCION.articulos).toContain('"precioUnitario"')
    expect(PROMPTS_EXTRACCION.articulos).toContain('"subtotal"')
    // Y desde el 2026-09-17 la descripcion: es con lo que se vincula un
    // renglon sin codigo (31 campos + 5 datos por item entra, medido).
    expect(PROMPTS_EXTRACCION.articulos).toContain('"descripcion"')
    expect(PROMPTS_EXTRACCION.articulos).toContain('descuentogeneral')
    // El precio impreso puede ser el de lista: se copia, no se recalcula.
    expect(PROMPTS_EXTRACCION.articulos).toContain('No lo recalcules')
  })

  it('el descuento general solo se le pide a articulos', () => {
    expect(PROMPTS_EXTRACCION.articulos).toContain('- descuentogeneral:')
    expect(PROMPTS_EXTRACCION.conceptos).not.toContain('descuentogeneral')
    expect(PROMPTS_EXTRACCION.tarjeta).not.toContain('descuentogeneral')
  })

  it('no le pide renglones a los tipos que no los usan', () => {
    expect(PROMPTS_EXTRACCION.conceptos).not.toContain('renglones_pdf')
    expect(PROMPTS_EXTRACCION.tarjeta).not.toContain('renglones_pdf')
  })

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'el de %s no le pide renglones al modelo',
    (tipo) => {
      expect(PROMPTS_EXTRACCION[tipo]).not.toMatch(/un rengl[oó]n por cada/i)
    },
  )

  it.each(TIPOS_FACTURA.map((t) => t.clave))(
    'el de %s no nombra ningun campo que no le vaya a pedir',
    (tipoDelTest) => {
    // El prompt lista los campos al final. Si una regla del cuerpo nombra
    // un campo que no esta en esa lista, el modelo sale a buscar un dato
    // que despues no tiene donde poner. Paso con `condiva`, que la regla
    // del proveedor nombraba de mas.
    const prompt = PROMPTS_EXTRACCION[tipoDelTest]
    const listados = camposIaPara(tipoDelTest).map((c) => c.clave)
    for (const clave of CAMPOS_NO_ANALIZADOS[tipoDelTest]) {
      expect(listados).not.toContain(clave)
      expect(prompt, `el prompt de ${tipoDelTest} nombra ${clave}`).not.toContain(`${clave}:`)
    }
    },
  )

  it('el de conceptos avisa que no se le piden esos campos', () => {
    expect(PROMPTS_EXTRACCION.conceptos).toContain('FACTURA DE CONCEPTOS')
    expect(PROMPTS_EXTRACCION.conceptos).toContain('no vas a encontrar esos campos')
  })

  it('el de tarjeta menciona SIRCREB, que es el codigo que solo aparece ahi', () => {
    expect(PROMPTS_EXTRACCION.tarjeta).toContain('LIQUIDACIÓN DE TARJETA')
    expect(PROMPTS_EXTRACCION.tarjeta).toContain('SIRCREB')
  })

  it('solo el de tarjeta explica que el numero puede venir como numero de liquidacion', () => {
    // Verificado contra el PDF real de VALLE FERTIL (010108): el numero
    // figura como "Nro. Liquidacion : 2388983", y el documento trae ademas
    // un "Comprobante a Liquidar : PLAN SI 3X1" que no es un numero. Sin
    // esta regla el modelo lo leia igual, pero por inferencia y con
    // confianza 0,8; con la regla sube a 0,97.
    expect(PROMPTS_EXTRACCION.tarjeta).toContain('número de liquidación')
    expect(PROMPTS_EXTRACCION.tarjeta).toContain('"PLAN SI 3X1"')

    // En los otros dos tipos la regla no aplica y solo seria ruido.
    expect(PROMPTS_EXTRACCION.conceptos).not.toContain('número de liquidación')
    expect(PROMPTS_EXTRACCION.articulos).not.toContain('número de liquidación')
  })

  it('el de tarjeta pide dejar tipo y ptovta vacios en vez de deducirlos', () => {
    // Estas liquidaciones no imprimen letra ni punto de venta. Un ptovta
    // deducido del codigo de comercio arma un N_COMP que no existe en
    // Tango, y eso rompe tanto el chequeo de duplicados como el registro.
    expect(PROMPTS_EXTRACCION.tarjeta).toContain('dejá tipo y ptovta vacíos')
  })

  it('los tres explican que cuenta como linea de Ingresos Brutos', () => {
    // El prompt NO pide la jurisdiccion normalizada: pide el rotulo tal como
    // esta impreso -- cambio del 2026-09-11, pedido del usuario. Lo que si
    // se le sigue diciendo es que cuenta como linea de IIBB, porque eso es
    // lo que decide que vaya en percepN y no en variosN. El codigo lo
    // resuelve la app despues (ver resolverPercepcionIibb): pedirselo al
    // modelo seria pedirle que memorice un maestro de Tango.
    for (const t of CON_IMPUESTOS) {
      const p = PROMPTS_EXTRACCION[t.clave]
      for (const j of JURISDICCIONES_IIBB) {
        expect(p, `${t.clave} no explica cuando es ${j.jurisdiccion}`).toContain(j.criterio)
      }
    }
  })

  it('los tres piden el rotulo impreso y no la jurisdiccion normalizada', () => {
    // La regresion concreta: una liquidacion de Valle Fertil cuyo renglon
    // dice "Retencion Ingresos Brutos" mostraba "Bancarias" en pantalla, una
    // etiqueta que no esta en el comprobante y que el operador no tiene
    // contra que cotejar.
    for (const t of CON_IMPUESTOS) {
      const p = PROMPTS_EXTRACCION[t.clave]
      expect(p, `${t.clave} no pide el rotulo`).toContain('percepN es el RÓTULO de esa línea')
      // La frase corta en el medio: se busca un tramo que no cruce el salto.
      expect(p, `${t.clave} no prohibe normalizar`).toContain(
        'reemplazarlo por el nombre de la provincia',
      )
    }
  })

  it('los tres explican los pares de percepcion y de impuestos varios', () => {
    for (const t of CON_IMPUESTOS) {
      const p = PROMPTS_EXTRACCION[t.clave]
      expect(p, `${t.clave} no explica percepN/imppercepN`).toContain('percepN/imppercepN')
      expect(p, `${t.clave} no explica variosN/impvariosN`).toContain('variosN/impvariosN')
    }
  })

  it('el del remito no trae las reglas de impuestos y pide la cantidad entregada', () => {
    const p = PROMPTS_EXTRACCION.remito
    expect(p).toContain('REMITO')
    expect(p).toContain('ENTREGADA')
    expect(p).not.toContain('percepN/imppercepN')
    expect(p).not.toContain('porcivaN/impivaN')
  })

  it('numera las reglas de corrido, sin saltos ni repetidos', () => {
    for (const t of TIPOS_FACTURA) {
      const numeros = [...PROMPTS_EXTRACCION[t.clave].matchAll(/^(\d+)\. /gm)].map((m) =>
        Number(m[1]),
      )
      expect(numeros.length).toBeGreaterThan(4)
      expect(numeros, `la numeracion de ${t.clave} no es correlativa`).toEqual(
        numeros.map((_, i) => i + 1),
      )
    }
  })

  it('supera el minimo cacheable de 512 tokens (~2000 caracteres) en los tres', () => {
    // El prompt va con cache_control: si no llega al minimo, la API lo
    // ignora en silencio y se paga el prompt entero en cada comprobante.
    for (const t of TIPOS_FACTURA) {
      expect(PROMPTS_EXTRACCION[t.clave].length).toBeGreaterThan(2000)
    }
  })
})
