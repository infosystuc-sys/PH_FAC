import { leerConfiguracionCarpetas } from '@/server/app/acciones/configuracion'
import { FormularioCarpetas } from '@/components/configuracion/formulario-carpetas'
import styles from './configuracion.module.css'

export const dynamic = 'force-dynamic'

export default async function ConfiguracionPage() {
  const config = await leerConfiguracionCarpetas()

  return (
    <main className={styles.main}>
      <div className={styles.contenido}>
        <div className={styles.titulo}>
          <h1 className={styles.h1}>Configuración</h1>
          <p className={styles.sub}>Importación automática de comprobantes desde carpetas.</p>
        </div>

        <FormularioCarpetas config={config} />
      </div>
    </main>
  )
}
