import Link from 'next/link'
import { probarConexion } from '@/server/db/pool'
import { usuarioActual } from '@/lib/usuario'
import { Icono } from './icono'
import styles from './header-global.module.css'

function iniciales(nombre: string): string {
  const partes = nombre.replace(/[._-]/g, ' ').trim().split(/\s+/)
  return partes.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '?'
}

/** El logo de RivAI, tal cual el documento de estilo (sección 7). */
function LogoRivai({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="rivai-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#2B7FE8" />
          <stop offset="0.5" stopColor="#4A3FC8" />
          <stop offset="1" stopColor="#8B3FC9" />
        </linearGradient>
      </defs>
      <path
        d="M11 4c-3 0-5 2-5 4.5 0 .7.2 1.3.5 1.8-1.5.8-2.5 2.3-2.5 4.2 0 1.3.5 2.5 1.4 3.4-.6.9-.9 1.9-.9 3 0 2.7 2.2 4.9 4.9 4.9.9 0 1.7-.2 2.4-.6.7 1.1 2 1.8 3.4 1.8 1.5 0 2.7-.7 3.5-1.8.7.4 1.5.6 2.4.6 2.7 0 4.9-2.2 4.9-4.9 0-1.1-.3-2.1-.9-3 .9-.9 1.4-2.1 1.4-3.4 0-1.9-1-3.4-2.5-4.2.3-.5.5-1.1.5-1.8C24 6 22 4 19 4c-1.3 0-2.5.5-3.3 1.2C14.8 4.5 13.7 4 12.5 4c-.5 0-1 0-1.5.1z"
        stroke="url(#rivai-grad)"
        strokeWidth="1.5"
      />
      <circle cx="11" cy="10" r="1.3" fill="#2B7FE8" />
      <circle cx="16" cy="8" r="1.3" fill="#4A3FC8" />
      <circle cx="22" cy="11" r="1.3" fill="#6B3FBC" />
      <circle cx="10" cy="17" r="1.3" fill="#3A4FD0" />
      <circle cx="16" cy="16" r="1.3" fill="#5B3FB8" />
      <circle cx="22" cy="18" r="1.3" fill="#8B3FC9" />
      <circle cx="13" cy="22" r="1.3" fill="#4A3FC8" />
      <circle cx="19" cy="23" r="1.3" fill="#6B3FBC" />
      <path
        d="M11 10 L16 8 L22 11 M10 17 L16 16 L22 18 M13 22 L19 23 M16 8 L16 16 M16 16 L13 22 M16 16 L19 23"
        stroke="url(#rivai-grad)"
        strokeWidth="1"
        opacity="0.6"
      />
    </svg>
  )
}

/**
 * La barra superior del sistema visual Rivai ERP (2026-10-17): 44px,
 * degradado oscuro, logo de 20 con el wordmark, y a la derecha el contexto
 * --la base de Tango-- con el mismo aspecto que el selector Sucursal·PV del
 * documento.
 */
export async function HeaderGlobal() {
  const conexion = await probarConexion()
  const usuario = usuarioActual()
  const base = process.env.SQLSERVER_DB ?? ''
  const tamano = 20

  return (
    <header className={styles.header} data-header-global>
      <Link href="/comprobantes" className={styles.logo}>
        <LogoRivai size={Math.round(tamano * 1.15)} />
        <span className={styles.wordmark} style={{ fontSize: Math.round(tamano * 0.82) }}>
          Riv<span className="brand-grad-text">AI</span>
        </span>
      </Link>
      <span className={styles.sep} />
      <span className={styles.modulo}>
        Comprobantes <span className={styles.moduloSub}>· Cuentas a pagar</span>
      </span>

      <div className={styles.derecha}>
        <span className={styles.ctx} title={conexion.ok ? undefined : 'Sin conexión a Tango'}>
          <span
            className={styles.punto}
            style={{ background: conexion.ok ? 'var(--conexion-ok)' : 'var(--danger)' }}
          />
          <span className={styles.ctxLabel}>TANGO</span>
          <span className={styles.ctxValor}>{conexion.ok ? base : 'Sin conexión'}</span>
        </span>
        <Link href="/configuracion" className={styles.icono} title="Configuración">
          <Icono nombre="settings" />
        </Link>
        <span className={styles.avatar} title={usuario}>
          {iniciales(usuario)}
        </span>
      </div>
    </header>
  )
}
