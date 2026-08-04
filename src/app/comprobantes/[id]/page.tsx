import Link from 'next/link'

export default async function RevisionPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  return (
    <main style={{ padding: 28 }}>
      <Link href="/comprobantes">← Bandeja</Link>
      <p style={{ marginTop: 16, color: '#6b7078', fontSize: 13 }}>
        Revisión del comprobante {id}. Llega en la Fase 2.
      </p>
    </main>
  )
}
