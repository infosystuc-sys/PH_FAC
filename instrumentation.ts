export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { arrancarWorker } = await import('@/server/app/cola')
    arrancarWorker()
  }
}
