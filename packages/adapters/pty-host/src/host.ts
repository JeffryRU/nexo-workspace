// Proceso «pty host»: único dueño de node-pty. Si el código nativo (ConPTY) se cae, solo muere este proceso.
// Lo lanza el adaptador con `child_process.fork`; habla por IPC (ver protocol.ts). Es solo composición: la lógica
// está en host-handler.ts y se prueba allí.
import process from 'node:process'
import * as nodePty from 'node-pty'
import { createHostHandler } from './host-handler.ts'
import type { HostEvent } from './protocol.ts'

function send(event: HostEvent): void {
  if (!process.connected) return
  try {
    process.send?.(event)
  } catch {
    // Canal cerrado entre la comprobación y el envío: el evento 'disconnect' termina el proceso.
  }
}

const handler = createHostHandler({
  platform: process.platform,
  send,
  log: (message) => console.error(`pty-host: ${message}`),
  exit: () => process.exit(0),
  spawnPty: (o) =>
    nodePty.spawn(o.file, o.args, {
      name: o.name,
      cols: o.cols,
      rows: o.rows,
      cwd: o.cwd,
      env: o.env,
      useConptyDll: o.conptyDll,
    }),
})

process.on('message', handler)
// Si el daemon muere o cierra el canal, no quedan terminales huérfanas.
process.on('disconnect', () => process.exit(0))
send({ t: 'ready' })
