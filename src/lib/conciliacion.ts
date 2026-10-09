import type { ClaseComprobante } from './arca'

/**
 * Cruza lo que ARCA informa contra lo que está cargado en Tango
 * (2026-10-09, pedido del usuario).
 *
 * Es lógica pura: las dos listas llegan ya leídas --una del archivo, la
 * otra de `CPA04`-- y acá solo se emparejan. Así se prueba sin base y sin
 * archivo, que es lo que importa en algo que decide si una factura "falta".
 */

/** Un comprobante informado por ARCA, con lo justo para cruzarlo. */
export type FilaArca = {
  id: number
  fechaEmision: Date
  letra: string | null
  clase: ClaseComprobante
  puntoVenta: number
  numero: number
  cuitEmisor: string
  razonEmisor: string | null
  importeTotal: number
}

/** Un comprobante cargado en Tango, ya con el CUIT de su proveedor. */
export type FilaTango = {
  tipo: string
  nComp: string
  codProvee: string
  cuitProveedor: string
  razonProveedor: string | null
  fechaEmision: Date | null
  importeTotal: number
}

/**
 * A qué clase corresponde cada `T_COMP` de Tango.
 *
 * Se empareja por CLASE y no por el código exacto porque Tango distingue
 * `NC1` de `NC2` y ARCA no informa esa diferencia: las dos son una nota de
 * crédito. Medido sobre la base el 2026-10-09: la terna
 * (proveedor, `N_COMP`, `T_COMP`) es única --0 duplicados-- pero
 * (proveedor, `N_COMP`) sola NO lo es: hay 15 casos donde el mismo número
 * existe como factura y como nota de crédito. Por eso la clase entra en la
 * clave: sin ella, una NC taparía a su factura.
 */
const CLASE_DE_TCOMP: Record<string, ClaseComprobante> = {
  FAC: 'factura',
  NC1: 'nota-credito',
  NC2: 'nota-credito',
  ND1: 'nota-debito',
  ND2: 'nota-debito',
}

export function claseDeTcomp(tcomp: string): ClaseComprobante {
  return CLASE_DE_TCOMP[tcomp.trim().toUpperCase()] ?? 'otro'
}

/**
 * La clave con la que se emparejan los dos lados: quién emitió, qué clase
 * de comprobante, y su número.
 *
 * NO entra la letra. Tango la guarda adentro de `N_COMP` pero hay
 * comprobantes viejos cargados sin ella ("00000050000779" en vez de
 * "A0000500000779"), y exigirla los dejaría a todos como faltantes. El
 * número de comprobante ya es único por (emisor, clase, punto de venta)
 * según la numeración de ARCA, así que la letra no agrega nada.
 */
export function clave(cuit: string, clase: ClaseComprobante, pv: number, nro: number): string {
  return `${cuit}|${clase}|${pv}|${nro}`
}

/**
 * El punto de venta y el número de un `N_COMP` de Tango.
 *
 * `N_COMP` NO tiene un formato único. Medido sobre las 17.483 filas de la
 * base el 2026-10-09, conviven al menos tres:
 *
 *   A0021400004214   letra + punto de venta(5) + número(8)
 *   00005-00004889   punto de venta(5) + guion + número(8)
 *   00001700002540   punto de venta(6) + número(8)
 *
 * Los catorce caracteres son fijos, pero lo que va adelante del número no.
 * Por eso se lee DESDE ATRÁS: los últimos ocho son el número --eso no
 * cambia nunca-- y de lo que queda adelante se toman los dígitos, que es
 * el punto de venta sin importar si viene con letra, con guion o pegado.
 *
 * Partirlo por posiciones fijas leía mal los cientos de filas con guion.
 */
export function partirNComp(nComp: string): { puntoVenta: number; numero: number } | null {
  const t = nComp.trim()
  if (t.length < 9) return null

  const numero = Number(t.slice(-8).replace(/\D/g, ''))
  const cabeza = t.slice(0, -8).replace(/\D/g, '')
  if (cabeza === '' || !Number.isFinite(numero)) return null

  return { puntoVenta: Number(cabeza), numero }
}

export type EstadoConciliacion = 'coincide' | 'falta-en-tango' | 'falta-en-arca' | 'difiere'

export type ResultadoFila = {
  estado: EstadoConciliacion
  arca: FilaArca | null
  tango: FilaTango | null
  /** Qué difiere, cuando el estado es `difiere`. */
  diferencia: string | null
}

/**
 * Cuánto puede diferir un importe antes de marcarlo. Un peso: los dos
 * lados redondean a dos decimales y ARCA a veces informa el total con una
 * diferencia de centavos contra lo que se cargó.
 */
const TOLERANCIA_IMPORTE = 1

export type OpcionesConciliacion = {
  /**
   * Hasta dónde la ausencia en ARCA significa algo. Un comprobante de
   * Tango anterior al archivo no es un faltante: el archivo simplemente no
   * lo cubre. Sin esto, con 16.735 facturas en Tango desde 2002 y un
   * archivo de un mes, "falta en ARCA" listaría toda la historia.
   */
  desde: Date | null
  hasta: Date | null
}

/**
 * El cruce. Cada comprobante de ARCA se busca en TODO Tango --sin filtrar
 * por fecha-- para que uno cargado con la fecha equivocada igual aparezca
 * como cargado y no como faltante. El filtro de fechas se aplica solo al
 * revés: a los de Tango que no están en ARCA.
 */
export function conciliar(
  arca: FilaArca[],
  tango: FilaTango[],
  { desde, hasta }: OpcionesConciliacion,
): ResultadoFila[] {
  const porClave = new Map<string, FilaTango[]>()
  for (const t of tango) {
    const partes = partirNComp(t.nComp)
    if (!partes) continue
    const k = clave(t.cuitProveedor, claseDeTcomp(t.tipo), partes.puntoVenta, partes.numero)
    const lista = porClave.get(k)
    if (lista) lista.push(t)
    else porClave.set(k, [t])
  }

  const usados = new Set<FilaTango>()
  const salida: ResultadoFila[] = []

  for (const a of arca) {
    const k = clave(a.cuitEmisor, a.clase, a.puntoVenta, a.numero)
    const candidatos = (porClave.get(k) ?? []).filter((t) => !usados.has(t))
    const t = candidatos[0]

    if (!t) {
      salida.push({ estado: 'falta-en-tango', arca: a, tango: null, diferencia: null })
      continue
    }
    usados.add(t)

    const difImporte = Math.abs(t.importeTotal - a.importeTotal)
    if (difImporte > TOLERANCIA_IMPORTE) {
      salida.push({
        estado: 'difiere',
        arca: a,
        tango: t,
        diferencia: `ARCA informa ${a.importeTotal.toFixed(2)} y en Tango está ${t.importeTotal.toFixed(2)}`,
      })
      continue
    }
    salida.push({ estado: 'coincide', arca: a, tango: t, diferencia: null })
  }

  // Lo que está en Tango y ARCA no informa, dentro del período cubierto.
  for (const t of tango) {
    if (usados.has(t)) continue
    if (!t.fechaEmision) continue
    if (desde && t.fechaEmision < desde) continue
    if (hasta && t.fechaEmision > hasta) continue
    salida.push({ estado: 'falta-en-arca', arca: null, tango: t, diferencia: null })
  }

  return salida
}

/** El recuento por estado, para la franja de arriba de la pantalla. */
export function resumir(filas: ResultadoFila[]): Record<EstadoConciliacion, number> {
  const r: Record<EstadoConciliacion, number> = {
    coincide: 0,
    'falta-en-tango': 0,
    'falta-en-arca': 0,
    difiere: 0,
  }
  for (const f of filas) r[f.estado] += 1
  return r
}
