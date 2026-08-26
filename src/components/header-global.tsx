import Link from 'next/link'
import { probarConexion } from '@/server/db/pool'
import { usuarioActual } from '@/lib/usuario'
import styles from './header-global.module.css'

function iniciales(nombre: string): string {
  const partes = nombre.replace(/[._-]/g, ' ').trim().split(/\s+/)
  return partes.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

export async function HeaderGlobal() {
  const conexion = await probarConexion()
  const usuario = usuarioActual()
  const base = process.env.SQLSERVER_DB ?? ''

  return (
    <header className={styles.header}>
      <div className={styles.logo}>C</div>
      <span className={styles.marca}>Comprobantes</span>
      <span className={styles.seccion}>Cuentas a pagar</span>

      <div className={styles.derecha}>
        <Link href="/configuracion" className={styles.config}>
          Configuración
        </Link>
        <span
          className={styles.punto}
          style={{ background: conexion.ok ? 'var(--conexion-ok)' : 'var(--error)' }}
        />
        <span className={styles.conexion}>
          {conexion.ok ? `Tango · BD ${base}` : 'Sin conexión a Tango'}
        </span>

        <div className={styles.usuarioBloque}>
          <span className={styles.avatar}>{iniciales(usuario)}</span>
          <span className={styles.usuario}>{usuario}</span>
        </div>
      </div>
    </header>
  )
}
