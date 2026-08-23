import { notFound } from 'next/navigation'
import { obtenerEncabezado, obtenerVecinos } from '@/server/app/comprobantes'
import { obtenerDetalle } from '@/server/app/detalle'
import { validarComprobante, validarListoParaRegistrar } from '@/server/app/validaciones'
import { listarCondicionesCompra } from '@/server/tango/condicionesCompra'
import { listarCodigosImpuesto, listarAlicuotasIva } from '@/server/tango/impuestos'
import { buscarRemitosPendientes } from '@/server/tango/remitos'
import { conceptoDelComprobante } from '@/server/tango/conceptos'
import { cargarAprendidos } from '@/server/app/aprendizajeImpuestos'
import { probarConexion } from '@/server/db/pool'
import { leerFiltro } from '@/lib/estados'
import { Pantalla } from '@/components/revision/pantalla'
import { BarraAcciones } from '@/components/revision/barra-acciones'
import { PanelProcesando } from '@/components/revision/panel-procesando'
import { PanelError } from '@/components/revision/panel-error'
import type { ValorInicial } from '@/components/revision/formulario'
import styles from './revision.module.css'

export const dynamic = 'force-dynamic'

/**
 * "FAC A 0003-00018742", o lo que haya con lo que se leyó hasta ahora. No
 * se reconstruye con PUNTO_VENTA: la bandeja (ver Tabla en
 * bandeja/tabla.tsx) ya muestra NUMERO solo, sin combinarlo, porque los
 * datos sembrados por `pnpm seed` lo traen con el punto de venta incluido
 * ("0003-00018742") mientras que la extracción real lo deja separado
 * ("00018742" + PUNTO_VENTA "0003") -- combinar los dos acá duplicaría el
 * punto de venta para las filas de seed. Mismo criterio que la bandeja:
 * mostrar NUMERO tal cual viene.
 */
function formatComprobante(tipo: string | null, numero: string | null): string {
  const partes = [tipo, numero].filter(Boolean)
  return partes.length > 0 ? partes.join(' ') : '—'
}

export default async function RevisionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ filtro?: string; q?: string }>
}) {
  const { id: idParam } = await params
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const sp = await searchParams
  const filtro = leerFiltro(sp.filtro)
  const query = sp.q ?? ''

  // El id tiene que ser válido y el comprobante tiene que existir antes de
  // pedir nada más: gatean el 404, así que van antes del Promise.all.
  const encabezado = await obtenerEncabezado(id)
  if (!encabezado) notFound()

  // Solo hace falta para la pantalla de revisión (implica leer Tango: CUIT,
  // duplicados en CPA04). En `procesando` y `error` ni siquiera se muestra
  // el formulario, así que evaluarla ahí sería trabajo tirado.
  const mostrarRevision = encabezado.estado !== 'procesando' && encabezado.estado !== 'error'

  // Estas tres no dependen entre sí ni del resultado de las otras -- van en
  // paralelo en vez de en serie. `validarComprobante` queda afuera del
  // Promise.all porque necesita el `detalle` ya resuelto (se lo pasa para
  // no releer PHF_CAMPO/PHF_RENGLON/PHF_AUDITORIA una segunda vez adentro).
  const [vecinos, detalle, condicionesCompra, codigosImpuesto, alicuotasIva, conexion] =
    await Promise.all([
      obtenerVecinos({ filtro, query }, id),
      obtenerDetalle(id),
      mostrarRevision ? listarCondicionesCompra() : Promise.resolve([]),
      mostrarRevision ? listarCodigosImpuesto() : Promise.resolve([]),
      mostrarRevision ? listarAlicuotasIva() : Promise.resolve([]),
      probarConexion(),
    ])

  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  const anteriorHref = vecinos.anteriorId ? `/comprobantes/${vecinos.anteriorId}${sufijo}` : null
  const siguienteHref = vecinos.siguienteId ? `/comprobantes/${vecinos.siguienteId}${sufijo}` : null

  const hayCorrecciones = detalle.campos.some((c) => c.corregido)

  const validaciones = mostrarRevision ? await validarComprobante(id, detalle) : null
  // Se calcula durante toda la revisión, no solo en `confirmado`: es el
  // panel que muestra a qué alícuota y a qué percepción de Tango va cada
  // línea del comprobante, y eso es justamente lo que el operador tiene
  // que poder cotejar contra el PDF mientras revisa. Calcularlo recién al
  // confirmar dejaba esa correspondencia invisible en el único momento en
  // que sirve para corregirla.
  const listoParaRegistrar = mostrarRevision ? await validarListoParaRegistrar(id, detalle) : null

  const codProveeCampo = detalle.campos.find((c) => c.clave === 'codprovee')?.valorFinal ?? null
  const tipoFacturaValor = detalle.campos.find((c) => c.clave === 'tipoFactura')?.valorFinal ?? null
  // 'conceptos' y 'tarjeta' no se atan a un remito -- ver validarTipoFactura.
  const sinRemito = tipoFacturaValor === 'conceptos' || tipoFacturaValor === 'tarjeta'
  const remitosPendientes =
    !sinRemito && codProveeCampo && detalle.renglones.length > 0
      ? await buscarRemitosPendientes(codProveeCampo)
      : []

  // En conceptos sale de la ficha del proveedor y en tarjeta es el fijo de
  // comisiones; en articulos no hay. Se resuelve aca porque depende de
  // codprovee, y cuando el operador elige otro proveedor `elegirProveedor`
  // hace revalidatePath y esto se recalcula.
  const concepto = mostrarRevision
    ? await conceptoDelComprobante(tipoFacturaValor, codProveeCampo)
    : null

  // Lo que este proveedor ya le enseñó a la app para IVA e IIBB (ver
  // aprendizajeImpuestos.ts), para que las celdas de "En Tango" del
  // formulario propongan en vivo lo mismo que va a resolver el registro
  // real -- sin esto, una celda podía mostrar "Sin código en Tango" en
  // rojo para algo que el registro iba a resolver solo.
  const [aprendidosIva, aprendidosPercepcion] =
    mostrarRevision && codProveeCampo
      ? await Promise.all([
          cargarAprendidos(codProveeCampo, 'iva'),
          cargarAprendidos(codProveeCampo, 'percepcion'),
        ])
      : [{}, {}]

  return (
    <div className={styles.pantalla}>
      <BarraAcciones
        id={id}
        estado={encabezado.estado}
        proveedor={encabezado.razonSocial ?? '—'}
        comprobante={formatComprobante(encabezado.tipo, encabezado.numero)}
        bloqueante={validaciones?.bloqueante ?? false}
        sinConexion={!conexion.ok}
        bloqueanteRegistro={listoParaRegistrar?.bloqueante ?? false}
        tangoNComp={encabezado.tangoNComp}
        anteriorHref={anteriorHref}
        siguienteHref={siguienteHref}
      />

      {encabezado.estado === 'procesando' && <PanelProcesando />}

      {encabezado.estado === 'error' && (
        <PanelError id={id} mensaje={encabezado.errorMensaje} hayCorrecciones={hayCorrecciones} />
      )}

      {mostrarRevision && validaciones && (
        <Pantalla
          key={id}
          comprobanteId={id}
          nombreArchivo={encabezado.archivoNombre}
          // `valorFinal` es el que se muestra: arranca igual al leído por la
          // IA y pasa a ser la corrección del operador en cuanto guarda algo
          // (ver guardarCampoEn en server/app/detalle.ts). `VALOR_IA` nunca
          // se toca.
          iniciales={Object.fromEntries(
            detalle.campos.map((c): [string, ValorInicial] => [
              c.clave,
              { valor: c.valorFinal ?? '', confianza: c.confianza },
            ]),
          )}
          campos={detalle.campos.filter((c) => c.valorIA !== null).length}
          ms={encabezado.extraccionMs}
          modelo={encabezado.extraccionModelo}
          confianza={encabezado.confianzaPromedio}
          hayCorrecciones={hayCorrecciones}
          renglones={detalle.renglones}
          auditoria={detalle.auditoria}
          validaciones={validaciones}
          listoParaRegistrar={listoParaRegistrar}
          condicionesCompra={condicionesCompra}
          codigosImpuesto={codigosImpuesto}
          alicuotasIva={alicuotasIva}
          concepto={concepto}
          aprendidosIva={aprendidosIva}
          aprendidosPercepcion={aprendidosPercepcion}
          remitosPendientes={remitosPendientes}
          codProvee={codProveeCampo}
          motivoObservacion={
            encabezado.estado === 'observacion' ? encabezado.motivoObservacion : null
          }
          notaObservacion={encabezado.estado === 'observacion' ? encabezado.notaObservacion : null}
          // `registrado` y `existente` son terminales e inmutables (mismo
          // criterio que ya aplica BarraAcciones deshabilitando "Ver
          // asiento en Tango"). El backend ya bloquea la escritura en
          // guardarCampoEn con un no-op silencioso para los dos; sin esto
          // la UI seguía mostrando el campo como editable y el operador
          // nunca se enteraba de que su corrección no se guardó.
          soloLectura={encabezado.estado === 'registrado' || encabezado.estado === 'existente'}
        />
      )}
    </div>
  )
}
