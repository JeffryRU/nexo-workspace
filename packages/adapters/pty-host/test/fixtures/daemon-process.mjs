// Hace de daemon en un proceso aparte: usa PtyHostPort con el host indicado y cuenta cualquier
// uncaughtException/unhandledRejection como fallo. Salida: una línea JSON y código 0 si todo fue bien.
import process from 'node:process'
import { PtyHostPort } from '../../src/pty-host-port.ts'

const [entry] = process.argv.slice(2)
const failures = []
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    failures.push(`${event}: ${error instanceof Error ? error.stack : String(error)}`)
  })
}
const logs = []
const record = (level) => (message) => logs.push(`${level}: ${message}`)
const port = new PtyHostPort({
  entry,
  logger: { debug() {}, info: record('info'), warn: record('warn'), error: record('error') },
})

let exit = 'timeout'
try {
  const proc = await port.spawn({ cmd: process.execPath, args: [], cols: 80, rows: 24 })
  exit = await Promise.race([
    new Promise((resolve) => proc.onExit(resolve)),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000)),
  ])
  proc.resize(100, 30)
  proc.write('x')
  proc.kill()
} catch (error) {
  failures.push(`spawn: ${error instanceof Error ? error.stack : String(error)}`)
}
port.dispose()
await new Promise((resolve) => setTimeout(resolve, 100))
console.log(JSON.stringify({ exit, failures, logs }))
process.exit(failures.length === 0 && exit !== 'timeout' ? 0 : 1)
