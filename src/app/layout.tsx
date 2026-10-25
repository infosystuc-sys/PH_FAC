import type { Metadata } from 'next'
import { HeaderGlobal } from '@/components/header-global'
import { ToastProvider } from '@/components/toast/toast-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'Comprobantes · Cuentas a pagar',
  description: 'Importador de comprobantes de compra hacia Tango',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-AR" suppressHydrationWarning>
      <head>
        {/* Dentro de Retail-local la app corre en un iframe y Retail pone la barra
            superior y el menú: se marca el modo embebido antes del primer pintado
            para no mostrar la barra propia ni un instante. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "if(window.top!==window.self)document.documentElement.setAttribute('data-embebido','1')",
          }}
        />
      </head>
      <body style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <HeaderGlobal />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  )
}
