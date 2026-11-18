import Link from 'next/link'
import { PanelDnrpa } from '@/components/dnrpa/panel'
import styles from './dnrpa.module.css'

export const dynamic = 'force-dynamic'

/**
 * Cargar el DNRPA de las motos desde el mail del proveedor (2026-11-18,
 * pedido del usuario). El remito se registra sin el DNRPA y este llega
 * después, en un mail con la tabla de certificados: la app la lee y lo pone
 * en el comentario de cada serie en Tango (STA06 y STA07).
 */
export default function DnrpaPage() {
  return (
    <main className={styles.main}>
      <div className={styles.contenido}>
        <div className={styles.titulo}>
          <div>
            <h1 className={styles.h1}>DNRPA de las motos</h1>
            <p className={styles.sub}>
              Subí el mail del proveedor con la tabla de certificados (PDF o imagen). Cada NRO DE CHASIS se busca
              entre las series de Tango y su NRO DNRPA va al comentario de la serie.
            </p>
          </div>
          <Link href="/comprobantes" className={styles.volver}>
            ← Bandeja
          </Link>
        </div>
        <PanelDnrpa />
      </div>
    </main>
  )
}
