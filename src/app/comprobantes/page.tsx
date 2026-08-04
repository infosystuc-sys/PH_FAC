import { listarComprobantes, obtenerKpis, contarPorEstado } from '@/server/app/comprobantes'
import type { ClaveTab } from '@/lib/estados'
import { ORDEN_TABS } from '@/lib/estados'
import { FilaKpis } from '@/components/bandeja/kpis'
import { Filtros } from '@/components/bandeja/filtros'
import { Tabla } from '@/components/bandeja/tabla'
import styles from './bandeja.module.css'

export const dynamic = 'force-dynamic'

function leerFiltro(v: string | undefined): ClaveTab {
  const valido = ORDEN_TABS.some((t) => t.clave === v)
  return valido ? (v as ClaveTab) : 'todos'
}

export default async function BandejaPage({
  searchParams,
}: {
  searchParams: Promise<{ filtro?: string; q?: string }>
}) {
  const sp = await searchParams
  const filtro = leerFiltro(sp.filtro)
  const query = sp.q ?? ''

  const [{ filas, total }, kpis, conteos] = await Promise.all([
    listarComprobantes({ filtro, query }),
    obtenerKpis(),
    contarPorEstado(query),
  ])

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
          <button type="button" className={styles.primario} disabled title="Disponible en la Fase 2">
            + Importar PDF
          </button>
        </div>

        <FilaKpis kpis={kpis} />
        <Filtros filtro={filtro} query={query} conteos={conteos} />
        <Tabla filas={filas} />

        <p className={styles.pie}>{total} comprobantes</p>
      </div>
    </main>
  )
}
