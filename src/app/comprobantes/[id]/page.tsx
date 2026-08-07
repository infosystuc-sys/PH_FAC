import { notFound } from 'next/navigation'
import { obtenerEncabezado, obtenerVecinos } from '@/server/app/comprobantes'
import { obtenerDetalle } from '@/server/app/detalle'
import { validarComprobante } from '@/server/app/validaciones'
import { listarCondicionesCompra } from '@/server/tango/condicionesCompra'
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

  const encabezado = await obtenerEncabezado(id)
  if (!encabezado) notFound()

  const vecinos = await obtenerVecinos({ filtro, query }, id)
  const qs = new URLSearchParams()
  if (filtro !== 'todos') qs.set('filtro', filtro)
  if (query) qs.set('q', query)
  const sufijo = qs.toString() ? `?${qs.toString()}` : ''

  const anteriorHref = vecinos.anteriorId ? `/comprobantes/${vecinos.anteriorId}${sufijo}` : null
  const siguienteHref = vecinos.siguienteId ? `/comprobantes/${vecinos.siguienteId}${sufijo}` : null

  const detalle = await obtenerDetalle(id)
  const hayCorrecciones = detalle.campos.some((c) => c.corregido)

  // Solo hace falta para la pantalla de revisión (implica leer Tango: CUIT,
  // duplicados en CPA04). En `procesando` y `error` ni siquiera se muestra
  // el formulario, así que evaluarla ahí sería trabajo tirado.
  const mostrarRevision = encabezado.estado !== 'procesando' && encabezado.estado !== 'error'
  const validaciones = mostrarRevision ? await validarComprobante(id) : null
  const condicionesCompra = mostrarRevision ? await listarCondicionesCompra() : []

  return (
    <div className={styles.pantalla}>
      <BarraAcciones
        id={id}
        estado={encabezado.estado}
        proveedor={encabezado.razonSocial ?? '—'}
        comprobante={formatComprobante(encabezado.tipo, encabezado.numero)}
        bloqueante={validaciones?.bloqueante ?? false}
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
          condicionesCompra={condicionesCompra}
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
