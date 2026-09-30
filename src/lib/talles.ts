import { normalizarCodigo } from './cotejoOc'

/**
 * Facturas que traen el desglose por talle adentro de un renglón.
 *
 * Hay proveedores de indumentaria y calzado que imprimen UNA línea por
 * artículo y color, con las cantidades abiertas por talle debajo, y una
 * cantidad total:
 *
 *     167686 001  SHORT CORE RUN H negro
 *                 L : 6  M : 4  S : 2  XL : 4      16   20799,47   7,00   309496,11
 *
 * En Tango cada talle es un artículo distinto --el código del proveedor con
 * el talle agregado al final-- y la orden de compra viene abierta igual:
 * esa línea son CUATRO renglones de OC (`167686 001 S`, `167686 001 M`,
 * `167686 001 L`, `167686 001 XL`).
 *
 * Sin abrir el renglón, la app busca el código pelado `167686`. Ese código
 * EXISTE en el maestro como artículo padre, así que lo da por reconocido y
 * después no encuentra ninguna orden que lo tenga pendiente: el operador ve
 * "reconocido, sin pendiente de facturar" y no puede registrar. Lo reportó
 * el usuario el 2026-09-24 con TOPPER (factura A 00184804 contra la OC
 * 1674).
 *
 * El desglose no se pide como campo aparte: el schema de artículos ya está
 * en el techo de la gramática de structured outputs --31 campos de cabecera
 * y 5 por ítem entran, 6 por ítem lo rechaza la API (medido el
 * 2026-09-24)--. Viene adentro de la descripción, que se transcribe entera,
 * y se parsea acá.
 */

/** Un talle con la cantidad que la factura cobra de ESE talle. */
export type Talle = { talle: string; cantidad: number }

/**
 * Los formatos que imprimen los proveedores para el desglose. Todos son
 * pares "etiqueta : cantidad" separados por espacios; lo que cambia es si
 * hay espacio alrededor de los dos puntos.
 *
 * La etiqueta es alfanumérica (`S`, `XL`, `270`, `38`) y la cantidad es un
 * entero: son unidades de mercadería, no importes, así que no se admiten
 * decimales ni separadores de miles. Eso es lo que evita confundir el
 * desglose con el resto de la descripción -- "26-001-ICO4-178220-P" no
 * matchea, y un precio "20.799,47" tampoco.
 */
const PAR = /([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9/]{1,4})\s*:\s*(\d{1,4})(?![\d.,/])/g

/**
 * Cuántos pares hacen falta para tomarlo por un desglose. Con uno solo no
 * alcanza: cualquier "Lote : 3" o "Bulto : 2" suelto daría un falso
 * positivo, y abrir un renglón que no correspondía es peor que no abrirlo
 * --el operador ve el error, pero recién en Tango--.
 */
const MINIMO_PARES = 2

/**
 * El desglose por talle que trae una descripción, o `[]` si no trae.
 *
 * No valida contra la cantidad total: eso lo hace `cuadraConTotal`, porque
 * la decisión de qué hacer cuando no cuadra es de quien llama.
 */
export function parsearDesgloseTalles(texto: string | null | undefined): Talle[] {
  if (!texto) return []
  const salida: Talle[] = []
  const vistos = new Set<string>()
  let finAnterior = -1

  for (const m of texto.matchAll(PAR)) {
    const inicio = m.index ?? 0
    // Los pares de un desglose van PEGADOS: entre uno y el siguiente no hay
    // más que espacios. Es lo que lo distingue de dos palabras sueltas con
    // dos puntos. DASS imprime "Despacho:26042IC05005688F Fec:13/03/2026"
    // adentro de la descripción, y sin esta condición "spacho:26042" y
    // "Fec:13" pasaban por un desglose de dos talles -- encontrado el
    // 2026-09-30, al ver que la app aprendía la regla equivocada para ese
    // proveedor. Lo que hay antes del primer par no importa: ahí está la
    // descripción del artículo.
    if (finAnterior >= 0 && texto.slice(finAnterior, inicio).trim() !== '') {
      salida.length = 0
      vistos.clear()
    }
    finAnterior = inicio + m[0].length

    const talle = m[1].trim()
    const cantidad = Number(m[2])
    const clave = normalizarCodigo(talle)
    // Un talle repetido invalida el desglose entero: no hay forma de saber
    // cuál de las dos cantidades vale, y elegir una sería inventar.
    if (clave === '' || vistos.has(clave)) return []
    vistos.add(clave)
    salida.push({ talle, cantidad })
  }
  return salida.length >= MINIMO_PARES ? salida : []
}

/** La suma de los talles, para cotejarla contra la cantidad impresa. */
export function totalDesglosado(talles: Talle[]): number {
  return talles.reduce((a, t) => a + t.cantidad, 0)
}

/**
 * La descripción sin el desglose, para mostrarla en el renglón de cada
 * talle. "SHORT CORE RUN H negro 26-001 L : 6 M : 4" con el talle `L`
 * queda "SHORT CORE RUN H negro 26-001 - L".
 */
export function describirTalle(texto: string | null | undefined, talle: string): string {
  const limpia = (texto ?? '').replace(PAR, '').replace(/\s+/g, ' ').trim()
  return limpia === '' ? talle : `${limpia} - ${talle}`
}

/**
 * A qué artículo de Tango corresponde cada talle.
 *
 * `candidatos` son los códigos de artículo donde buscar -- los renglones de
 * la OC que se está imputando, o los de todas las órdenes con pendiente del
 * proveedor. No se compone el código por concatenación: entre el código del
 * proveedor y el talle suele haber un color (`167686` + `001` + `S`), y
 * además el relleno de espacios cambia de proveedor en proveedor
 * (`80020  001 L`, `10801  1113M`). Se busca entre los códigos que Tango ya
 * tiene, que es la única fuente de verdad del formato.
 *
 * El talle se asigna de más largo a más corto. Es lo que evita que `L` se
 * quede con el renglón de `XL`: `XL` elige primero --es el único que
 * termina en "XL"-- y cuando le toca a `L` ese candidato ya está tomado.
 * Entre varios candidatos libres que terminan igual gana el más corto, por
 * la misma razón.
 *
 * Devuelve `null` si algún talle se queda sin candidato: un desglose
 * resuelto a medias no sirve: lo que falte se factura contra un artículo
 * equivocado o no se factura, y las dos cosas terminan mal en Tango.
 */
export function articulosPorTalle(
  codigoImpreso: string | null | undefined,
  talles: Talle[],
  candidatos: string[],
): Map<string, string> | null {
  const prefijo = normalizarCodigo(codigoImpreso ?? '')
  if (prefijo === '' || talles.length === 0) return null

  // Solo los que son ese código MÁS algo: el artículo padre --el código
  // pelado, que también está en el maestro-- no es de ningún talle.
  const conPrefijo = candidatos
    .map((c) => ({ codigo: c, clave: normalizarCodigo(c) }))
    .filter((c) => c.clave.length > prefijo.length && c.clave.startsWith(prefijo))
  if (conPrefijo.length === 0) return null

  const usados = new Set<string>()
  const salida = new Map<string, string>()
  const porLargo = [...talles].sort(
    (a, b) => normalizarCodigo(b.talle).length - normalizarCodigo(a.talle).length,
  )

  let completo = true
  for (const { talle } of porLargo) {
    const sufijo = normalizarCodigo(talle)
    if (sufijo === '') return null
    const libres = conPrefijo
      .filter((c) => !usados.has(c.clave) && c.clave.endsWith(sufijo))
      .sort((a, b) => a.clave.length - b.clave.length)
    const elegido = libres[0]
    if (!elegido) {
      completo = false
      break
    }
    usados.add(elegido.clave)
    salida.set(talle, elegido.codigo)
  }
  if (completo) return salida

  // El talle impreso y el guardado pueden estar en distinta escala: TOPPER
  // factura "310 320 330" y en Tango los artículos terminan en "31 32 33"
  // --el papel escribe el talle en décimos--. Se resuelve buscando UN factor
  // que explique el renglón entero, no arreglando talle por talle: si la
  // misma división lleva los siete talles impresos a los siete artículos de
  // la orden, uno a uno, la correspondencia es la que es. Un factor que
  // funcione para algunos y no para todos se descarta entero.
  return porEscalaNumerica(talles, conPrefijo, prefijo)
}

/**
 * La correspondencia talle → artículo cuando los dos están en escalas
 * numéricas distintas, o `null` si no hay un factor que explique todo el
 * renglón.
 */
function porEscalaNumerica(
  talles: Talle[],
  conPrefijo: { codigo: string; clave: string }[],
  prefijo: string,
): Map<string, string> | null {
  const restos = new Map<string, string>()
  for (const c of conPrefijo) {
    const resto = c.clave.slice(prefijo.length)
    // Dos artículos con el mismo resto no puede pasar --serían el mismo
    // código-- pero si pasara, no hay forma de elegir.
    if (restos.has(resto)) return null
    restos.set(resto, c.codigo)
  }

  const esNumero = (s: string) => /^\d+$/.test(s)
  if (!talles.every((t) => esNumero(t.talle.trim()))) return null
  if (![...restos.keys()].every(esNumero)) return null

  // Del impreso al guardado se divide (310 → 31) o se multiplica (31 → 310).
  const factores: { k: number; dividir: boolean }[] = [
    { k: 10, dividir: true },
    { k: 100, dividir: true },
    { k: 10, dividir: false },
    { k: 100, dividir: false },
  ]

  for (const { k, dividir } of factores) {
    const salida = new Map<string, string>()
    const usados = new Set<string>()
    let sirve = true

    for (const { talle } of talles) {
      const n = Number(talle.trim())
      if (dividir && n % k !== 0) {
        sirve = false
        break
      }
      const buscado = String(dividir ? n / k : n * k)
      const codigo = restos.get(buscado)
      // Uno a uno: un artículo no puede quedar asignado a dos talles.
      if (!codigo || usados.has(buscado)) {
        sirve = false
        break
      }
      usados.add(buscado)
      salida.set(talle, codigo)
    }

    if (sirve && salida.size === talles.length) return salida
  }
  return null
}

/**
 * Reparte un importe entre los talles en proporción a sus cantidades, con
 * el resto al último, para que la suma dé EXACTAMENTE el importe impreso.
 *
 * Hace falta porque el subtotal que imprime la factura es el de la línea
 * entera --309.496,11 por las 16 unidades-- y cada talle se graba en
 * `CPA46` por separado. Prorratear y redondear cada uno por su cuenta deja
 * una diferencia de centavos contra el neto gravado, que es justo lo que
 * `descuentoGlobal.ts` verifica antes de dejar registrar.
 */
/** Lo que la factura cobra por una línea impresa, ya resuelto. */
export type NetoLinea = { importeNeto: number; precioNeto: number }

/** Un renglón a registrar, con la línea del PDF de la que salió. */
export type RenglonAReparto = { id: number; pdfOrden: number | null; cantidad: number }

/**
 * El importe que le toca a cada renglón cuando varios salen de la MISMA
 * línea del PDF.
 *
 * Es el caso de una factura desglosada por talle: la línea impresa tiene un
 * solo subtotal --309.496,11 por las 16 unidades-- y en Tango se graban
 * cuatro renglones, uno por talle. Sin repartir, cada uno se llevaba el
 * importe entero de la línea y la factura entraba multiplicada por cuatro.
 *
 * El PRECIO unitario no se reparte: es el mismo artículo al mismo precio en
 * todos los talles, y es además el que figura en la orden de compra. Lo que
 * se reparte es el importe, con el resto de redondeo al último, para que la
 * suma de los renglones dé exactamente el neto de la línea -- que es contra
 * lo que `descuentoGlobal.ts` valida el comprobante.
 */
export function repartirNetoEntreHermanos(
  renglones: RenglonAReparto[],
  netoPorLinea: Map<number, NetoLinea>,
): Map<number, NetoLinea> {
  const porLinea = new Map<number, RenglonAReparto[]>()
  for (const r of renglones) {
    if (r.pdfOrden === null) continue
    const grupo = porLinea.get(r.pdfOrden)
    if (grupo) grupo.push(r)
    else porLinea.set(r.pdfOrden, [r])
  }

  const salida = new Map<number, NetoLinea>()
  for (const [pdfOrden, grupo] of porLinea) {
    const neto = netoPorLinea.get(pdfOrden)
    if (!neto) continue
    // Una linea que dio un solo renglon se graba tal cual: sin reparto no
    // hay redondeo que pueda mover un centavo.
    if (grupo.length === 1) {
      salida.set(grupo[0].id, neto)
      continue
    }
    const partes = prorratear(
      neto.importeNeto,
      grupo.map((r) => r.cantidad),
    )
    grupo.forEach((r, i) => {
      salida.set(r.id, { importeNeto: partes[i], precioNeto: neto.precioNeto })
    })
  }
  return salida
}

export function prorratear(importe: number, cantidades: number[]): number[] {
  const total = cantidades.reduce((a, c) => a + c, 0)
  if (total <= 0) return cantidades.map(() => 0)

  const centavos = Math.round(importe * 100)
  const partes: number[] = []
  let repartido = 0
  for (let i = 0; i < cantidades.length - 1; i += 1) {
    const parte = Math.round((centavos * cantidades[i]) / total)
    partes.push(parte)
    repartido += parte
  }
  partes.push(centavos - repartido)
  return partes.map((c) => c / 100)
}
