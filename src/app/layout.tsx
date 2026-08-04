import type { Metadata } from 'next'
import { HeaderGlobal } from '@/components/header-global'
import './globals.css'

export const metadata: Metadata = {
  title: 'Comprobantes · Cuentas a pagar',
  description: 'Importador de comprobantes de compra hacia Tango',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <HeaderGlobal />
        {children}
      </body>
    </html>
  )
}
