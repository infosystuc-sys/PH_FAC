import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Comprobantes · Cuentas a pagar',
  description: 'Importador de comprobantes de compra hacia Tango',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR">
      <body>{children}</body>
    </html>
  )
}
