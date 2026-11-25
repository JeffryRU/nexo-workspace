// Host de prueba con la lógica real (host-handler) y una terminal falsa cuyo `onExit` llega sin código de
// salida, como hace node-pty con ConPTY a veces (issue #37). Ni resize ni write ni kill fallan.
import process from 'node:process'
import { createHostHandler } from '../../src/host-handler.ts'

const send = (event) => {
  if (process.connected) process.send(event)
}
const handler = createHostHandler({
  platform: process.platform,
  send,
  log: (message) => console.error(`exitless-host: ${message}`),
  exit: () => process.exit(0),
  spawnPty: () => {
    let onExit = () => {}
    setTimeout(() => onExit({ exitCode: undefined, signal: undefined }), 20)
    return {
      pid: 4242,
      write() {},
      resize() {},
      kill() {},
      onData() {},
      onExit(listener) {
        onExit = listener
      },
    }
  },
})
process.on('message', handler)
process.on('disconnect', () => process.exit(0))
send({ t: 'ready' })
