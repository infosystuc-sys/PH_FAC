import { redirect } from 'next/navigation'
import { listarComprobantes, obtenerKpis, contarPorEstado } from '@/server/app/comprobantes'
import { leerFiltro } from '@/lib/estados'
import { FilaKpis } from '@/components/bandeja/kpis'
import { Filtros } from '@/components/bandeja/filtros'
import { Tabla } from '@/components/bandeja/tabla'
import { Paginacion } from '@/components/bandeja/paginacion'
import { BotonImportar } from '@/components/bandeja/importar'
import { RefrescoAutomatico } from '@/components/bandeja/refresco'
import styles from './bandeja.module.css'

export const dynamic = 'force-dynamic'

const LIMITE_PAGINA = 100

function leerPagina(v: string | undefined): number {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : 1
}

export default async function BandejaPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; q?: string; pagina?: string }>
}) {
  const sp = await searchParams
  const filtro = leerFiltro(sp.filtro)
  const query = sp.q ?? ''
  const pagina = leerPagina(sp.pagina)
  const offset = (pagina - 1) * LIMITE_PAGINA

  const [{ filas, total }, kpis, conteos] = await Promise.all([
    listarComprobantes({ filtro, query, limite: LIMITE_PAGINA, offset }),
    obtenerKpis(),
    contarPorEstado(query),
  ])

  const totalPaginas = Math.max(1, Math.ceil(total / LIMITE_PAGINA))

  // La pagina pedida puede quedar fuera de rango si el total encogio (o si
  // vino de un bookmark/URL a mano) despues de que ya se conocia `pagina`
  // por el searchParam. Recien aca, con `total` en mano, se puede detectar.
  // Con total === 0 no hay ninguna pagina valida a la que mandarlo: la
  // bandeja vacia se muestra tal cual, sin redirigir (evita un ciclo).
  if (total > 0 && pagina > totalPaginas) {
    const next = new URLSearchParams()
    if (filtro !== 'todos') next.set('filtro', filtro)
    if (query) next.set('q', query)
    if (totalPaginas > 1) next.set('pagina', String(totalPaginas))
    const qs = next.toString()
    redirect(`/comprobantes${qs ? `?${qs}` : ''}`)
  }

  const desde = total === 0 ? 0 : offset + 1
  const hasta = total === 0 ? 0 : Math.min(offset + filas.length, total)

  return (
    <main className={styles.main}>
      <div className={styles.contenido}>
        <div className={styles.titulo}>
          <div>
            <h1 className={styles.h1}>Bandeja de comprobantes</h1>
            <p className={styles.sub}>
              Importá los PDF, revisá lo que leyó la IA y registralo en Tango.
            </p>
          </div>
          <BotonImportar />
        </div>

        <FilaKpis kpis={kpis} />
        <Filtros filtro={filtro} query={query} conteos={conteos} />
        <Tabla filas={filas} filtro={filtro} query={query} />
        <RefrescoAutomatico procesando={conteos.procesando} />

        <Paginacion pagina={pagina} totalPaginas={totalPaginas} desde={desde} hasta={hasta} total={total} />
      </div>
    </main>
  )
}
