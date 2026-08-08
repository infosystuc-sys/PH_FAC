import { notFound } from 'next/navigation'
import { obtenerEncabezado, obtenerVecinos } from '@/server/app/comprobantes'
import { obtenerDetalle } from '@/server/app/detalle'
import { validarComprobante, validarListoParaRegistrar } from '@/server/app/validaciones'
import { listarCondicionesCompra } from '@/server/tango/condicionesCompra'
import { listarAlicuotasIva, listarCodigosImpuesto } from '@/server/tango/impuestos'
import { buscarRemitosPendientes } from '@/server/tango/remitos'
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
  const [vecinos, detalle, condicionesCompra, alicuotasIva, codigosImpuesto, conexion] = await Promise.all([
    obtenerVecinos({ filtro, query }, id),
    obtenerDetalle(id),
    mostrarRevision ? listarCondicionesCompra() : Promise.resolve([]),
    mostrarRevision ? listarAlicuotasIva() : Promise.resolve([]),
    mostrarRevision ? listarCodigosImpuesto() : Promise.resolve([]),
    probarConexion(),
  ])

  // codpercepiva desambigua el unico porcentaje ambiguo de CPA14 (3%, entre
  // "PERCEPCION R.G.3337" y "PERCEP. DE IVA" -- ver spec de Fase 4, seccion
  // 2). codpercibb lista los codigos de percepcion de IIBB (tipo IB), una
  // jurisdiccion por codigo.
  const codigosPercepcionIva3 = alicuotasIva.filter((a) => a.porcentaje === 3)
  const codigosIibb = codigosImpuesto.filter((c) => c.tipo === 'IB')

  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  const anteriorHref = vecinos.anteriorId ? `/comprobantes/${vecinos.anteriorId}${sufijo}` : null
  const siguienteHref = vecinos.siguienteId ? `/comprobantes/${vecinos.siguienteId}${sufijo}` : null

  const hayCorrecciones = detalle.campos.some((c) => c.corregido)

  const validaciones = mostrarRevision ? await validarComprobante(id, detalle) : null
  const listoParaRegistrar =
    encabezado.estado === 'confirmado' ? await validarListoParaRegistrar(id, detalle) : null

  const codProveeCampo = detalle.campos.find((c) => c.clave === 'codprovee')?.valorFinal ?? null
  const remitosPendientes =
    codProveeCampo && detalle.renglones.length > 0 ? await buscarRemitosPendientes(codProveeCampo) : []

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
          codigosIibb={codigosIibb}
          codigosPercepcionIva3={codigosPercepcionIva3}
          remitosPendientes={remitosPendientes}
          // `registrado` es terminal e inmutable (mismo criterio que ya
          // aplica BarraAcciones deshabilitando "Ver asiento en Tango"). El
          // backend ya bloquea la escritura en guardarCampoEn con un no-op
          // silencioso; sin esto la UI seguía mostrando el campo como
          // editable y el operador nunca se enteraba de que su corrección
          // no se guardó.
          soloLectura={encabezado.estado === 'registrado'}
        />
      )}
    </div>
  )
}
