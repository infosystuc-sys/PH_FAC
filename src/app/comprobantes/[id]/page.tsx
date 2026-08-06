import Link from 'next/link'
import { notFound } from 'next/navigation'
import { obtenerEncabezado } from '@/server/app/comprobantes'
import { obtenerDetalle } from '@/server/app/detalle'
import { Pantalla } from '@/components/revision/pantalla'
import type { ValorInicial } from '@/components/revision/formulario'
import styles from './revision.module.css'

export const dynamic = 'force-dynamic'

export default async function RevisionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id: idParam } = await params
  const id = Number(idParam)
  if (!Number.isInteger(id) || id <= 0) notFound()

  const encabezado = await obtenerEncabezado(id)
  if (!encabezado) notFound()

  const detalle = await obtenerDetalle(id)

  // `valorFinal` es el que se muestra: arranca igual al leído por la IA y
  // pasa a ser la corrección del operador en cuanto guarda algo (ver
  // guardarCampoEn en server/app/detalle.ts). `VALOR_IA` nunca se toca.
  const iniciales: Record<string, ValorInicial> = {}
  for (const campo of detalle.campos) {
    iniciales[campo.clave] = { valor: campo.valorFinal ?? '', confianza: campo.confianza }
  }

  return (
    <div className={styles.pantalla}>
      <div className={styles.barra}>
        <Link href="/comprobantes" className={styles.volver}>
          ← Bandeja
        </Link>
      </div>
      <Pantalla
        comprobanteId={id}
        nombreArchivo={encabezado.archivoNombre}
        iniciales={iniciales}
      />
    </div>
  )
}
