// Servidor web para las pruebas E2E y de rendimiento: compila apps/web (build de producción, lo que se
// distribuye) y la sirve con `vite preview` en el puerto 5173, el único origen de desarrollo que acepta el
// daemon con NEXO_DEV=1. Corre en el propio proceso (sin hijos) para que Playwright pueda detenerlo limpio.
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build, preview } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = join(root, 'apps/web')
const port = Number(process.env.NEXO_WEB_PORT ?? '5173')

await build({ root: webRoot, logLevel: 'warn' })
const server = await preview({
  root: webRoot,
  logLevel: 'warn',
  preview: { port, strictPort: true, host: 'localhost' },
})
console.log(`e2e-web: http://localhost:${port}`)

const stop = () => {
  server.httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, stop)
