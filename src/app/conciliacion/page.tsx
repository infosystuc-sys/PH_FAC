import Link from 'next/link'
import { conciliarEn } from '@/server/app/arca'
import { getPool } from '@/server/db/pool'
import { formatFecha } from '@/lib/formato'
import { PanelConciliacion, type FilaVista } from '@/components/conciliacion/panel'
import styles from './conciliacion.module.css'

export const dynamic = 'force-dynamic'

/**
 * Verificar que lo cargado en Tango sea lo que ARCA informa (2026-10-09,
 * pedido del usuario).
 *
 * Va en su propia ruta y no como un filtro de la bandeja: las pestañas de
 * la bandeja recortan la tabla de comprobantes de la app, y esto cruza dos
 * fuentes distintas --el archivo de ARCA y `CPA04`-- sin mirar `PHF_*`.
 */
export default async function ConciliacionPage() {
  const pool = await getPool()
  const { importacion, filas, resumen } = await conciliarEn(pool)

  // El cruce trae los dos comprobantes enteros; la pantalla muestra seis
  // columnas. Se aplana acá para no mandarle al cliente lo que no usa.
  const vista: FilaVista[] = filas.map((f) => {
    const a = f.arca
    const t = f.tango
    return {
      estado: f.estado,
      fecha: a ? formatFecha(a.fechaEmision) : t?.fechaEmision ? formatFecha(t.fechaEmision) : null,
      comprobante: a
        ? `${a.letra ?? ''} ${String(a.puntoVenta).padStart(5, '0')}-${String(a.numero).padStart(8, '0')}`.trim()
        : (t?.nComp.trim() ?? ''),
      cuit: a?.cuitEmisor ?? t?.cuitProveedor ?? '',
      razon: a?.razonEmisor ?? t?.razonProveedor ?? '',
      importeArca: a?.importeTotal ?? null,
      importeTango: t?.importeTotal ?? null,
      diferencia: f.diferencia,
    }
  })

  return (
    <main className={styles.main}>
      <div className={styles.contenido}>
        <div className={styles.titulo}>
          <div>
            <h1 className={styles.h1}>Conciliación con ARCA</h1>
            <p className={styles.sub}>
              Compara lo que está cargado en Tango contra lo que ARCA informa en &quot;Mis
              Comprobantes&quot;.
            </p>
          </div>
          <Link href="/comprobantes" className={styles.volver}>
            ← Bandeja
          </Link>
        </div>

        <PanelConciliacion
          filas={vista}
          resumen={resumen}
          importacion={
            importacion
              ? {
                  archivoNombre: importacion.archivoNombre,
                  desde: importacion.desde ? formatFecha(importacion.desde) : null,
                  hasta: importacion.hasta ? formatFecha(importacion.hasta) : null,
                  filas: importacion.filas,
                  fechaAlta: formatFecha(importacion.fechaAlta),
                  usuario: importacion.usuario,
                }
              : null
          }
        />
      </div>
    </main>
  )
}
