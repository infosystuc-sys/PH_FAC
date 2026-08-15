import { describe, it, expect } from 'vitest'
import { PROMPTS_EXTRACCION } from '@/server/ia/prompt'
import { TIPOS_FACTURA, CAMPOS_NO_ANALIZADOS } from '@/lib/tipoFactura'
import { camposIaPara } from '@/lib/campos'
import { JURISDICCIONES_IIBB } from '@/lib/percepcionIibb'

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

  it('el de articulos avisa que no se pide el detalle de renglones', () => {
    // Es el tipo donde el modelo tiene mas tentacion de listarlos: la
    // factura los enumera. El schema no los acepta, pero el prompt tiene que
    // decirlo igual o el modelo gasta atencion en un dato que se descarta.
    expect(PROMPTS_EXTRACCION.articulos).toContain('FACTURA DE ARTÍCULOS')
    expect(PROMPTS_EXTRACCION.articulos).toContain('No se te pide ese detalle')
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

  it('los tres listan las jurisdicciones de IIBB con su criterio', () => {
    // El prompt pide la JURISDICCION, no el codigo: el codigo lo resuelve
    // la app despues (ver resolverPercepcionIibb). Pedirle el codigo al
    // modelo seria pedirle que memorice un maestro de Tango.
    for (const t of TIPOS_FACTURA) {
      const p = PROMPTS_EXTRACCION[t.clave]
      for (const j of JURISDICCIONES_IIBB) {
        expect(p, `${t.clave} no lista ${j.jurisdiccion}`).toContain(`"${j.jurisdiccion}" para`)
        expect(p, `${t.clave} no explica cuando usar ${j.jurisdiccion}`).toContain(j.criterio)
      }
    }
  })

  it('los tres explican los pares de percepcion y de impuestos varios', () => {
    for (const t of TIPOS_FACTURA) {
      const p = PROMPTS_EXTRACCION[t.clave]
      expect(p, `${t.clave} no explica percepN/imppercepN`).toContain('percepN/imppercepN')
      expect(p, `${t.clave} no explica variosN/impvariosN`).toContain('variosN/impvariosN')
    }
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
