#!/usr/bin/env node
// Raíz de composición de la CLI: solo conecta lo real con `runCli`. La lógica vive en cli.ts.
import process from 'node:process'
import { runCli } from './cli.ts'
import { makeConnect, makeDaemonControl } from './launcher.ts'
import { findOnPath } from './shell.ts'

const controller = new AbortController()
const abort = () => controller.abort()
// SIGBREAK es el Ctrl+Break de Windows.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, abort)

/** Escribe en un flujo; si la tubería se cerró (EPIPE) calla y cancela el comando en curso. */
function sink(stream: NodeJS.WriteStream) {
  let closed = false
  const close = () => {
    closed = true
    abort()
  }
  stream.on('error', close)
  return {
    write(text: string): void {
      if (closed) return
      try {
        stream.write(text)
      } catch {
        close()
      }
    },
  }
}

const env = process.env
const code = await runCli(process.argv.slice(2), {
  io: {
    stdout: sink(process.stdout),
    stderr: sink(process.stderr),
    stdin: () => process.stdin,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  },
  connect: makeConnect(env),
  daemon: makeDaemonControl(env),
  env,
  platform: process.platform,
  cwd: () => process.cwd(),
  commandExists: (name) => findOnPath(name, env, process.platform),
  signal: controller.signal,
})
process.exitCode = code
// Red de seguridad: si algo deja el proceso vivo, sale igualmente.
setTimeout(() => process.exit(code), 2000).unref()
