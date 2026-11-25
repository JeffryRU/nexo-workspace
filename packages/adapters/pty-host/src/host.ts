// Proceso «pty host»: único dueño de node-pty. Si el código nativo (ConPTY) se cae, solo muere este proceso.
// Lo lanza el adaptador con `child_process.fork`; habla por IPC (ver protocol.ts).
import process from 'node:process'
import * as nodePty from 'node-pty'
import { type HostEvent, parseHostRequest } from './protocol.ts'

const KILL_SPACING_MS = 25
const isWindows = process.platform === 'win32'

type Entry = { pty: nodePty.IPty; exited: boolean; killRequested: boolean }
const terminals = new Map<number, Entry>()

function send(event: HostEvent): void {
  if (!process.connected) return
  try {
    process.send?.(event)
  } catch {
    // Canal cerrado entre la comprobación y el envío: el evento 'disconnect' termina el proceso.
  }
}

let killGate: Promise<void> = Promise.resolve()
/** En Windows, varios kill simultáneos pueden tumbar el proceso desde node-pty: se espacian. */
function spacedKill(action: () => void): void {
  killGate = killGate.then(async () => {
    action()
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_SPACING_MS))
  })
}

function safeKill(pty: nodePty.IPty, signal: string | undefined): void {
  try {
    pty.kill(signal)
  } catch {
    // Ya murió.
  }
}

function handle(raw: unknown): void {
  const parsed = parseHostRequest(raw)
  if (!parsed.ok) {
    console.error(`pty-host: mensaje inválido descartado (${parsed.error})`)
    return
  }
  const msg = parsed.value
  switch (msg.t) {
    case 'spawn': {
      if (terminals.has(msg.id)) {
        send({ t: 'spawn-error', id: msg.id, message: 'id de terminal repetido' })
        return
      }
      try {
        const pty = nodePty.spawn(msg.file, msg.args, {
          name: msg.name,
          cols: msg.cols,
          rows: msg.rows,
          cwd: msg.cwd,
          env: msg.env,
          useConptyDll: msg.conptyDll,
        })
        const entry: Entry = { pty, exited: false, killRequested: false }
        terminals.set(msg.id, entry)
        send({ t: 'spawned', id: msg.id, pid: pty.pid })
        pty.onData((data) => send({ t: 'data', id: msg.id, data }))
        pty.onExit((e) => {
          entry.exited = true
          terminals.delete(msg.id)
          send({ t: 'exit', id: msg.id, exitCode: e.exitCode, signal: e.signal ?? null })
        })
      } catch (error) {
        send({
          t: 'spawn-error',
          id: msg.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    case 'shutdown': {
      for (const entry of terminals.values()) {
        entry.killRequested = true
        const pty = entry.pty
        if (isWindows) spacedKill(() => safeKill(pty, undefined))
        else safeKill(pty, 'SIGHUP')
      }
      killGate.then(() => setTimeout(() => process.exit(0), 200))
      return
    }
    case 'write':
    case 'resize': {
      const entry = terminals.get(msg.id)
      // Tras pedir kill en Windows el handle nativo ya está cerrado: tocarlo puede dar violación de acceso.
      if (entry === undefined || entry.exited || (isWindows && entry.killRequested)) return
      try {
        if (msg.t === 'write') entry.pty.write(msg.data)
        else entry.pty.resize(msg.cols, msg.rows)
      } catch {
        // Carrera con la salida del proceso.
      }
      return
    }
    case 'kill': {
      const entry = terminals.get(msg.id)
      if (entry === undefined || entry.exited) return
      if (isWindows && entry.killRequested) return
      entry.killRequested = true
      const kill = (signal: string | undefined): void => {
        if (entry.exited) return
        try {
          entry.pty.kill(signal)
        } catch {
          // Ya murió; la notificación de salida está en camino.
        }
      }
      if (isWindows) spacedKill(() => kill(undefined))
      else kill(msg.signal ?? 'SIGTERM')
      return
    }
  }
}

process.on('message', handle)
// Si el daemon muere o cierra el canal, no quedan terminales huérfanas.
process.on('disconnect', () => process.exit(0))
send({ t: 'ready' })
