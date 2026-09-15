import { describe, it, expect } from 'vitest'
import { emparejarOcs } from '@/lib/matchOc'

/**
 * Las dos OC pendientes reales de CARRIER (010246) al implementar esto, y
 * la factura 8460, que cobra 30 de "MDRT489MTE46ADW" -- el sinonimo que
 * CPA15 traduce a nuestro 106037, renglon 6 de la 1632.
 */
const OC_1632 = {
  nOrdenCo: ' 0000100001632',
  renglones: [
    { codArticu: '106036' },
    { codArticu: '106141' },
    { codArticu: '106041' },
    { codArticu: '106037' },
    { codArticu: '105585' },
  ],
}
const OC_1595 = { nOrdenCo: ' 0000100001595', renglones: [{ codArticu: '106893' }] }
const OCS = [OC_1632, OC_1595]

const SINONIMOS = new Map([['MDRT489MTE46ADW', '106037']])

describe('emparejarOcs', () => {
  it('deja solo la OC que tiene el articulo que la factura cobra', () => {
    const r = emparejarOcs(['MDRT489MTE46ADW'], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
    expect(r.coinciden[0].articulos).toEqual(['106037'])
    expect(r.sinResolver).toEqual([])
  })

  it('acepta el codigo nuestro impreso tal cual, sin sinonimo', () => {
    // Hay proveedores que facturan con nuestro propio codigo.
    const r = emparejarOcs(['106893'], OCS, new Map())
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1595.nOrdenCo])
  })

  it('el codigo nuestro gana sobre el sinonimo, mismo criterio que el cotejo', () => {
    // Un proveedor que usa como sinonimo un codigo que tambien es nuestro.
    const sinonimos = new Map([['106893', '106037']])
    const r = emparejarOcs(['106893'], OCS, sinonimos)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1595.nOrdenCo])
  })

  it('empareja sin importar mayusculas ni espacios', () => {
    // El codigo sale de un PDF transcripto por el modelo; CPA15 y CPA36
    // estan en Latin1_General_BIN, que distingue mayusculas.
    const r = emparejarOcs(['  mdrt489mte46adw '], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
  })

  it('alcanza con UN articulo en comun: una factura puede partirse entre dos OC', () => {
    const r = emparejarOcs(['106037', '106893'], OCS, new Map())
    expect(r.coinciden).toHaveLength(2)
  })

  it('ordena por cantidad de articulos en comun, la que mas primero', () => {
    // La 1595 viene primera en la entrada y aun asi queda segunda: la 1632
    // cubre dos de los articulos facturados y ella uno solo.
    const r = emparejarOcs(['106893', '106037', '106141'], [OC_1595, OC_1632], new Map())
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo, OC_1595.nOrdenCo])
    expect(r.coinciden[0].articulos).toEqual(['106141', '106037'])
  })

  it('no coincide con ninguna cuando el codigo no esta en ninguna OC', () => {
    // El caso de la factura 8459, con dos codigos que CPA15 todavia no tiene.
    const r = emparejarOcs(['MDRT645MTE46ADW', 'MW-DG125BAR1'], OCS, new Map())
    expect(r.coinciden).toEqual([])
    expect(r.sinResolver).toEqual(['MDRT645MTE46ADW', 'MW-DG125BAR1'])
  })

  it('informa como sin resolver solo los que no emparejaron', () => {
    const r = emparejarOcs(['MDRT489MTE46ADW', 'NO-EXISTE'], OCS, SINONIMOS)
    expect(r.coinciden.map((c) => c.oc.nOrdenCo)).toEqual([OC_1632.nOrdenCo])
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('separa el codigo reconocido sin saldo del que no se reconoce', () => {
    // ZOZZOLI, 2026-09-15: 12100 tiene sinonimo en CPA15 (101406) pero ese
    // articulo no tiene pendiente en ninguna orden. Hasta ese dia iba a
    // sinResolver, la pantalla decia "no se reconoce" y ofrecia enseñar un
    // sinonimo que ya existia. Enseñar no lo arregla: falta una orden con
    // saldo. Es otra cosa y se informa aparte.
    const sinonimos = new Map([...SINONIMOS, ['12100', '101406']])
    const r = emparejarOcs(['12100', 'NO-EXISTE'], OCS, sinonimos)
    expect(r.coinciden).toEqual([])
    expect(r.reconocidosSinPendiente).toEqual([{ codigo: '12100', codArticu: '101406' }])
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('no repite un codigo sin resolver que la factura trae dos veces', () => {
    const r = emparejarOcs(['NO-EXISTE', 'no-existe'], OCS, new Map())
    expect(r.sinResolver).toEqual(['NO-EXISTE'])
  })

  it('sin renglones leidos del PDF no filtra nada', () => {
    // La IA no pudo leer el detalle: no hay con que emparejar, y devolver
    // "ninguna coincide" haria que la pantalla ofrezca todas, que es lo
    // correcto -- no que no ofrezca ninguna.
    expect(emparejarOcs([], OCS, SINONIMOS).coinciden).toEqual([])
    expect(emparejarOcs([null, '', '  '], OCS, SINONIMOS).sinResolver).toEqual([])
  })

  it('no cuenta dos veces un articulo que la OC repite en dos renglones', () => {
    const oc = {
      nOrdenCo: 'X',
      renglones: [{ codArticu: '106037' }, { codArticu: '106037' }],
    }
    const r = emparejarOcs(['106037'], [oc], new Map())
    expect(r.coinciden[0].articulos).toEqual(['106037'])
  })
})
