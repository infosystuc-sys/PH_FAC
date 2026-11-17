import { parsearImporteONulo } from './formato'

/**
 * Los casilleros de impuesto que la lectura trae con importe CERO no se
 * cargan (2026-11-17, pedido del usuario). Las liquidaciones listan todos
 * los impuestos posibles aunque no correspondan ("IVA 10,5% 0.00",
 * "IMPUESTO AL DEBITO 0.00", "REGIMEN DE RET.SIRTAC 0.00"), y cada uno
 * ocupaba un casillero que el operador tenía que vaciar a mano o que pedía
 * un código de Tango sin sentido.
 *
 * Se sacan de a pares (rótulo o alícuota + importe) y los que quedan se
 * corren hacia el primer casillero libre de su familia, para no dejar
 * huecos. Un importe VACÍO no es cero: ese casillero se deja, porque es
 * algo que falta leer.
 */
const FAMILIAS: readonly { rotulo: string; importe: string; cantidad: number }[] = [
  { rotulo: 'porciva', importe: 'impiva', cantidad: 5 },
  { rotulo: 'percep', importe: 'imppercep', cantidad: 4 },
  { rotulo: 'varios', importe: 'impvarios', cantidad: 2 },
]

export function descartarImpuestosEnCero<T extends { valor: string | null }>(
  campos: Record<string, T>,
  vacio: () => T,
): { campos: Record<string, T>; descartados: string[] } {
  const salida: Record<string, T> = { ...campos }
  const descartados: string[] = []
  for (const f of FAMILIAS) {
    const quedan: { rotulo: T; importe: T }[] = []
    let hayAlguno = false
    for (let i = 1; i <= f.cantidad; i++) {
      const rotulo = campos[`${f.rotulo}${i}`]
      const importe = campos[`${f.importe}${i}`]
      if (rotulo === undefined && importe === undefined) continue
      hayAlguno = true
      const r = rotulo ?? vacio()
      const imp = importe ?? vacio()
      if (r.valor === null && imp.valor === null) continue
      if (imp.valor !== null && parsearImporteONulo(imp.valor) === 0) {
        descartados.push(r.valor ?? `${f.rotulo}${i}`)
        continue
      }
      quedan.push({ rotulo: r, importe: imp })
    }
    if (!hayAlguno) continue
    // Solo los casilleros que el tipo de comprobante tiene: no todos piden
    // los cinco de IVA.
    let j = 0
    for (let i = 1; i <= f.cantidad; i++) {
      const kr = `${f.rotulo}${i}`
      const ki = `${f.importe}${i}`
      if (!(kr in campos) && !(ki in campos)) continue
      const q = quedan[j++]
      if (kr in campos) salida[kr] = q ? q.rotulo : vacio()
      if (ki in campos) salida[ki] = q ? q.importe : vacio()
    }
  }
  return { campos: salida, descartados }
}
