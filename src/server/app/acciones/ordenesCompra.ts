'use server'

// Server actions de órdenes de compra: ofrecerlas por renglón, imputarlas y quitarlas.

import { revalidatePath } from 'next/cache'
import { getPool } from '../../db/pool'
import { conTransaccion } from '../../db/tx'
import { obtenerDetalleEn } from '../detalle'
import { criterioOcDe, type CriterioOc } from '@/lib/tipoFactura'
import { articulosPorSinonimo, describirArticulos } from '@/server/tango/articulos'
import {
  emparejarOcs,
  resolverCodigoArticulo,
  lineasCargo,
  lineasContraOc,
  abrirPorTalle,
} from '@/lib/matchOc'
import {
  variantesPendientesDeBase,
  variantesDeEscala,
  type ArticuloDescripto,
} from '@/server/tango/articulos'
import { equivalenciasPorTalle } from '@/lib/talles'
import { parsearImporte } from '@/lib/formato'
import { reglaDeProveedorEn } from '../lecturaProveedor'
import { normalizarCodigo } from '@/lib/cotejoOc'
import { buscarOcPendientes, type OrdenCompra } from '@/server/tango/ordenesCompra'
import {
  agregarOcEn,
  quitarOcEn,
  renglonesSinOcEn,
  lineasPdfResueltasEn,
  quitarOcDeRenglonEn,
} from '../ordenCompra'

/** Las órdenes de compra del proveedor con algo pendiente de facturar. */
export async function listarOcDelProveedor(codProvee: string): Promise<OrdenCompra[]> {
  return buscarOcPendientes(codProvee)
}

/** El tipo que vale es el del campo: el operador lo puede cambiar en la revisión. */
async function criterioOcDelComprobante(comprobanteId: number): Promise<CriterioOc> {
  const detalle = await obtenerDetalleEn(await getPool(), comprobanteId)
  return criterioOcDe(detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal ?? null)
}

export type OcOfrecida = OrdenCompra & {
  /** Los códigos nuestros de esta OC que la factura cobra. Vacío si no se filtró. */
  articulosQueCoinciden: string[]
}

export type OfertaOc = {
  ocs: OcOfrecida[]
  /**
   * `false` cuando ninguna OC coincidió y se están ofreciendo todas. La
   * pantalla lo usa para avisar que no emparejó nada, en vez de dejar creer
   * que la lista ya está filtrada.
   */
  filtrada: boolean
  /** Los códigos impresos que no se pudieron llevar a ningún artículo. */
  sinResolver: string[]
  /** Los artículos de las OC pendientes, para enseñar un sinónimo. */
  articulosDisponibles: { codArticu: string; descripcion: string }[]
  /** Las OC ya imputadas a este comprobante. */
  imputadas: string[]
  /**
   * Con qué código imprime la factura cada artículo nuestro que coincidió:
   * nuestro código → el del proveedor. Solo los que difieren; si el
   * proveedor factura con nuestro propio código no hay nada que mostrar.
   * Pedido del usuario, 2026-09-15: al cotejar contra el papel, el código
   * que el operador ve impreso es el del proveedor.
   */
  codigosFactura: Record<string, string>
  /**
   * Los renglones de la factura que todavía no tienen artículo en ninguna
   * orden imputada. Mientras quede alguno, el comprobante no se registra.
   *
   * `hayCandidata` los parte en dos casos que no son lo mismo y que la
   * pantalla no puede mezclar: si alguna orden pendiente del proveedor tiene
   * ese artículo, no hay ningún problema que resolver -- falta que el
   * operador la impute, y está listada abajo. Si no la tiene, ahí sí es algo
   * que hay que arreglar antes de poder registrar.
   */
  sinOrden: {
    orden: number
    codigo: string
    cantidad: string | null
    hayCandidata: boolean
    /**
     * A qué artículo nuestro corresponde el código impreso, cuando se
     * reconoce (por sinónimo en CPA15, o porque ya es un código nuestro)
     * pero ninguna orden lo tiene con saldo. `null` cuando de verdad no se
     * reconoce: ese es el que el operador puede enseñar.
     */
    reconocidoComo: ArticuloDescripto | null
    /**
     * Si `reconocidoComo` es un artículo BASE de escala, las variantes que
     * la orden de este proveedor SÍ tiene pendientes: son los únicos
     * artículos contra los que ese renglón se puede facturar. Vacío en
     * cualquier otro caso.
     */
    variantesEscala: ArticuloDescripto[]
    /**
     * El código del papel llevado a los artículos de Tango, talle por talle.
     * Solo para MOSTRAR: sin una orden contra la cual resolver, el operador
     * no tenía forma de saber a qué artículo nuestro apunta "026459 001".
     * Vacío cuando el renglón no viene desglosado o algún talle no tiene
     * artículo -- no se muestra una equivalencia a medias.
     */
    equivalencias: {
      codigoFactura: string
      talle: string
      cantidad: number
      codArticu: string
      descripcion: string
    }[]
    /** La descripción impresa: es con lo que se vincula un renglón sin código. */
    descripcion: string | null
    /** El código salió de una descripción aprendida, no vino impreso. */
    porDescripcion: boolean
    /** Es un cargo del proveedor: se registra sin orden de compra. */
    sinOc: boolean
  }[]
  /**
   * Los cargos del proveedor de esta factura: se registran igual, sin orden
   * de compra. Se listan aparte para que el operador los vea y pueda
   * desmarcarlos.
   */
  cargos: { orden: number; descripcion: string | null; codigo: string; cantidad: string | null }[]
  /**
   * Todas las órdenes del proveedor con pendiente, sin filtrar: el
   * desplegable de cada renglón tiene que poder mostrar también la orden que
   * ya está imputada, que `ocs` deja afuera una vez que cubrió lo suyo.
   */
  todas: { nOrdenCo: string; fechaEmision: Date | null; total: number }[]
  /**
   * Por renglón del PDF (su ORDEN), las órdenes que tienen pendiente su
   * artículo. Es lo que ofrece el desplegable de OC de cada renglón
   * (2026-10-14, pedido del usuario).
   */
  candidatasPorRenglon: Record<number, string[]>
}

/**
 * Las órdenes de compra que se le ofrecen a ESTA factura: solo las que
 * contienen los artículos que cobra -- decisión del usuario, 2026-09-07.
 * El código impreso se lleva al nuestro por `CPA15.COD_SINONI`.
 *
 * Si no coincide ninguna se devuelven todas las pendientes con
 * `filtrada: false`, y la pantalla avisa. Es deliberado y no un descuido:
 * al implementarlo, `CPA15` tenía sinónimo cargado en 3 de sus 1.131 filas
 * y solo 2 de los 28 proveedores con OC pendiente tenían alguno, así que un
 * filtro estricto habría dejado sin poder imputar nada a casi todos. El
 * filtro se vuelve efectivo a medida que se enseñan los sinónimos, que es
 * para lo que está `asociarCodigoProveedor` en esta misma pantalla.
 */
export async function listarOcParaComprobante(
  comprobanteId: number,
  codProvee: string,
): Promise<OfertaOc> {
  // Un remito se imputa contra lo pendiente de RECIBIR, no de facturar.
  const criterio = await criterioOcDelComprobante(comprobanteId)
  const todas = await buscarOcPendientes(codProvee, criterio)
  const articulosDisponibles = [
    ...new Map(
      todas.flatMap((oc) =>
        oc.renglones.map((r) => [r.codArticu, { codArticu: r.codArticu, descripcion: r.descripcion }]),
      ),
    ).values(),
  ].sort((a, b) => a.codArticu.localeCompare(b.codArticu))

  const { detalle, sinOrden, lineas, regla } = await conTransaccion(async (tx) => {
    const detalle = await obtenerDetalleEn(tx, comprobanteId)
    return {
      detalle,
      sinOrden: await renglonesSinOcEn(tx, comprobanteId, codProvee),
      // Con el codigo aprendido por descripcion ya aplicado, para que un
      // renglon vinculado empareje igual que uno con codigo impreso.
      lineas: await lineasPdfResueltasEn(tx, detalle, codProvee),
      // Como lee la app las facturas de este proveedor: decide si una linea
      // con UN SOLO talle impreso se toma por un desglose.
      regla: await reglaDeProveedorEn(tx, codProvee),
    }
  })
  const imputadas = [
    ...new Set(detalle.renglones.map((r) => r.ocNOrdenCo).filter((x): x is string => !!x)),
  ]

  // Abierto por talle contra los articulos de TODAS las ordenes con
  // pendiente: si la factura desglosa (TOPPER), el codigo pelado que imprime
  // no esta en ninguna orden y sin abrir no se ofreceria la que corresponde.
  const abiertas = abrirPorTalle(
    lineas,
    todas.flatMap((oc) => oc.renglones.map((r) => r.codArticu)),
    regla?.escala === 'desglose-talle',
  )

  const codigos = abiertas.map((r) => r.codigo)
  const sinonimos = await articulosPorSinonimo(
    codProvee,
    codigos.map((c) => c ?? ''),
  )

  // Solo se ofrecen las OC que puedan aportar algo que todavia falta: si un
  // articulo ya lo trajo otra orden, esa orden no tiene nada nuevo que dar.
  const pendientesDeCubrir = sinOrden.map((r) => r.codigo)
  const emparejamiento = emparejarOcs(
    imputadas.length > 0 ? pendientesDeCubrir : codigos,
    todas,
    sinonimos,
  )
  const { coinciden } = emparejamiento

  // Dos cosas que hasta el 2026-09-15 se mostraban igual ("no se reconoce")
  // y no lo son: un codigo sin sinonimo, que el operador puede enseñar, y un
  // codigo que SI se reconoce pero cuyo articulo no tiene saldo en ninguna
  // orden, donde enseñar no arregla nada. Un codigo sin sinonimo puede ademas
  // ser directamente uno de los nuestros -- hay proveedores que facturan con
  // nuestro codigo --, asi que se consulta el maestro antes de darlo por
  // desconocido.
  const descripciones = await describirArticulos([
    ...emparejamiento.reconocidosSinPendiente.map((r) => r.codArticu),
    ...emparejamiento.sinResolver,
  ])
  const reconocidos = new Map<string, ArticuloDescripto>()
  for (const r of emparejamiento.reconocidosSinPendiente) {
    const enMaestro = descripciones.get(r.codArticu)
    // Clave normalizada: sinOrden trae el codigo impreso y busca con la clave.
    reconocidos.set(
      normalizarCodigo(r.codigo),
      enMaestro ?? { codArticu: r.codArticu, descripcion: '', escala: 'ninguna' },
    )
  }
  const sinResolver: string[] = []
  for (const codigo of emparejamiento.sinResolver) {
    const propio = descripciones.get(normalizarCodigo(codigo))
    if (propio) reconocidos.set(normalizarCodigo(codigo), propio)
    else sinResolver.push(codigo)
  }

  // Un codigo impreso que es un articulo BASE de Tango no es un articulo
  // facturable: le falta el sufijo de color o de talle (STA11.USA_ESC, ver
  // el tipo Escala). Se buscan sus variantes CON PENDIENTE en las ordenes
  // de este proveedor, que son los unicos articulos contra los que ese
  // renglon se puede facturar. Sin esto la pantalla decia "reconocido, sin
  // pendiente de facturar" y mandaba al operador a buscar una orden que no
  // existe (2026-09-30, reportado por el usuario con DASS).
  const bases = [...reconocidos.values()].filter((a) => a.escala === 'base')
  const variantes = bases.length > 0
    ? await variantesPendientesDeBase(codProvee, bases.map((a) => a.codArticu), criterio)
    : new Map<string, ArticuloDescripto[]>()

  // Un renglon sin orden imputada no es necesariamente un problema: si
  // alguna orden pendiente lo tiene, solo falta imputarla.
  const enAlgunaOc = new Set(
    todas.flatMap((oc) => oc.renglones.map((r) => normalizarCodigo(r.codArticu))),
  )
  // La equivalencia entre el codigo del papel y el articulo de Tango, talle
  // por talle, para los renglones que NO tienen orden (2026-10-05, pedido
  // del usuario con TOPPER A 00535956). Es solo de VISUALIZACION: sin una
  // orden contra la cual resolver, el operador veia "026459 001" a secas y
  // no tenia forma de saber a que articulo nuestro apunta. No imputa, no
  // valida y no registra: abrirPorTalle sigue trabajando solo contra las
  // ordenes.
  //
  // Un solo talle impreso ("350: 2") se acepta como desglose unicamente si
  // el proveedor ya esta marcado como 'desglose-talle': con un par suelto y
  // sin ese antecedente, cualquier "Lote : 3" pasaria por talle.
  const unTalle = regla?.escala === 'desglose-talle'
  const variantesEscalaPorPrefijo = await variantesDeEscala(sinOrden.map((r) => r.codigo))
  const descripcionDeVariante = new Map(
    [...variantesEscalaPorPrefijo.values()]
      .flat()
      .map((a) => [a.codArticu, a.descripcion] as const),
  )

  // Que ordenes pueden cubrir cada renglon del PDF. Un renglon desglosado
  // por talle se abrio en varios, todos con el mismo ORDEN: basta que la
  // orden tenga uno de sus talles para ofrecerla.
  const candidatasPorRenglon: Record<number, string[]> = {}
  for (const oc of todas) {
    const nuestros = new Set(oc.renglones.map((r) => normalizarCodigo(r.codArticu)))
    for (const linea of lineasContraOc(abiertas)) {
      if (resolverCodigoArticulo(linea.codigo, nuestros, sinonimos) === null) continue
      const lista = (candidatasPorRenglon[linea.orden] ??= [])
      if (!lista.includes(oc.nOrdenCo)) lista.push(oc.nOrdenCo)
    }
  }

  // El articulo de Tango de los renglones que SI tienen una orden con saldo:
  // `reconocidos` solo junta los que no la tienen, para explicar por que. Sin
  // esto la columna de Tango quedaba en "—" hasta imputar la orden, y un
  // sinonimo recien cargado en Tango parecia no encontrarse (2026-10-30,
  // reportado por el usuario con AGRO&TEC EY26SB7-12).
  const descripcionEnOc = new Map(
    todas.flatMap((oc) =>
      oc.renglones.map((x) => [normalizarCodigo(x.codArticu), { codArticu: x.codArticu, descripcion: x.descripcion }] as const),
    ),
  )
  const reconocidoEnOc = (codigo: string | null): ArticuloDescripto | null => {
    const art = resolverCodigoArticulo(codigo, enAlgunaOc, sinonimos)
    const enOc = art ? descripcionEnOc.get(art) : undefined
    return enOc ? { ...enOc, escala: 'ninguna' } : null
  }

  const sinOrdenAnotado = sinOrden.map((r) => ({
    ...r,
    // Con el renglon ya abierto por talle: el codigo pelado de una linea
    // desglosada ("052701 001") no esta en ninguna orden, pero sus talles si.
    // Mirando el codigo pelado, la linea de TOPPER decia que ninguna orden
    // la tenia mientras el desplegable de al lado ofrecia la que la cubre
    // entera (2026-10-14).
    hayCandidata:
      (candidatasPorRenglon[r.orden]?.length ?? 0) > 0 ||
      resolverCodigoArticulo(r.codigo, enAlgunaOc, sinonimos) !== null,
    reconocidoComo: reconocidos.get(normalizarCodigo(r.codigo)) ?? reconocidoEnOc(r.codigo),
    // Las variantes de escala pendientes, cuando el codigo es un base.
    variantesEscala:
      variantes.get(reconocidos.get(normalizarCodigo(r.codigo))?.codArticu ?? '') ?? [],
    // El codigo del papel llevado a los articulos de Tango, talle por talle.
    equivalencias: equivalenciasPorTalle(
      r.codigo,
      r.descripcion,
      parsearImporte(r.cantidad),
      (variantesEscalaPorPrefijo.get(normalizarCodigo(r.codigo)) ?? []).map((a) => a.codArticu),
      unTalle,
    ).map((e) => ({ ...e, descripcion: descripcionDeVariante.get(e.codArticu) ?? '' })),
    sinOc: false,
  }))

  // Nuestro codigo -> el impreso, para los que coincidieron via sinonimo.
  const codigosFactura: Record<string, string> = {}
  for (const impreso of codigos) {
    const crudo = (impreso ?? '').trim()
    const nuestro = resolverCodigoArticulo(crudo, enAlgunaOc, sinonimos)
    if (nuestro && nuestro !== normalizarCodigo(crudo)) codigosFactura[nuestro] = crudo
  }

  const base = {
    todas: todas.map((oc) => ({
      nOrdenCo: oc.nOrdenCo,
      fechaEmision: oc.fechaEmision,
      total: oc.total,
    })),
    candidatasPorRenglon,
    sinResolver,
    articulosDisponibles,
    imputadas,
    sinOrden: sinOrdenAnotado,
    codigosFactura,
    cargos: lineasCargo(lineas).map((l) => ({
      orden: l.orden,
      descripcion: l.descripcion,
      codigo: (l.codigo ?? '').trim(),
      cantidad: l.cantidad,
    })),
  }

  if (coinciden.length === 0) {
    return {
      ...base,
      ocs: todas.map((oc) => ({ ...oc, articulosQueCoinciden: [] })),
      filtrada: false,
    }
  }

  return {
    ...base,
    ocs: coinciden.map((c) => ({ ...c.oc, articulosQueCoinciden: c.articulos })),
    filtrada: true,
  }
}

/**
 * El operador imputa una orden de compra a esta factura de artículos. Trae
 * como detalle del comprobante los renglones de la OC que la factura cobra
 * -- ver `agregarOcEn`.
 *
 * Agrega: una factura puede repartirse entre varias órdenes, así que
 * imputar otra no borra lo que trajo la anterior.
 *
 * Con `revalidatePath` porque cambia los renglones enteros, que es lo que
 * la pantalla muestra debajo: sin refrescar, el operador elegiría una OC y
 * seguiría viendo el detalle anterior.
 */
export async function imputarOrdenCompra(
  comprobanteId: number,
  nOrdenCo: string,
  codProvee: string | null,
): Promise<{ renglones: number; sinEmparejar: number }> {
  const r = await conTransaccion((tx) => agregarOcEn(tx, comprobanteId, nOrdenCo, codProvee))
  revalidatePath(`/comprobantes/${comprobanteId}`)
  return { renglones: r.agregados, sinEmparejar: r.sinEmparejar }
}

/**
 * Imputa una orden de compra a UN renglón de la factura (2026-10-14,
 * pedido del usuario): la revisión elige la OC en cada renglón. Reemplaza
 * la que ese renglón tuviera.
 */
export async function imputarOcARenglon(
  comprobanteId: number,
  pdfOrden: number,
  nOrdenCo: string,
  codProvee: string | null,
): Promise<{ renglones: number }> {
  const r = await conTransaccion((tx) =>
    agregarOcEn(tx, comprobanteId, nOrdenCo, codProvee, pdfOrden),
  )
  revalidatePath(`/comprobantes/${comprobanteId}`)
  return { renglones: r.agregados }
}

/** Le saca a UN renglón de la factura la orden de compra que tenía. */
export async function quitarOcDeRenglon(
  comprobanteId: number,
  pdfOrden: number,
): Promise<{ renglones: number }> {
  const renglones = await conTransaccion((tx) => quitarOcDeRenglonEn(tx, comprobanteId, pdfOrden))
  revalidatePath(`/comprobantes/${comprobanteId}`)
  return { renglones }
}

/** Saca una orden de compra del comprobante, con los renglones que trajo. */
export async function desimputarOrdenCompra(
  comprobanteId: number,
  nOrdenCo: string,
): Promise<{ renglones: number }> {
  const renglones = await conTransaccion((tx) => quitarOcEn(tx, comprobanteId, nOrdenCo))
  revalidatePath(`/comprobantes/${comprobanteId}`)
  return { renglones }
}
