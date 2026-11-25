import { type HostEvent, parseHostRequest } from './protocol.ts'

/** Lo mínimo que el host necesita de un `IPty` de node-pty (permite probarlo con un falso). */
export type PtyLike = {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): unknown
  /** `exitCode` puede faltar en tiempo de ejecución aunque node-pty lo tipe como número. */
  onExit(
    listener: (e: { exitCode: number | undefined; signal?: number | undefined }) => void,
  ): unknown
}

export type HostSpawnOptions = {
  file: string
  args: string[]
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  conptyDll: boolean
}

export type HostDeps = {
  spawnPty(options: HostSpawnOptions): PtyLike
  send(event: HostEvent): void
  log(message: string): void
  /** Termina el proceso host. */
  exit(): void
  platform: NodeJS.Platform
  killSpacingMs?: number
}

type Entry = { pty: PtyLike; exited: boolean; killRequested: boolean }

/** Lógica del proceso host: una función que atiende cada mensaje IPC (ya recibido, sin validar). */
export function createHostHandler(deps: HostDeps): (raw: unknown) => void {
  const isWindows = deps.platform === 'win32'
  const spacing = deps.killSpacingMs ?? 25
  const terminals = new Map<number, Entry>()
  let killGate: Promise<void> = Promise.resolve()

  // En Windows, varios kill simultáneos pueden tumbar el proceso desde node-pty: se espacian.
  const spacedKill = (action: () => void): void => {
    killGate = killGate.then(async () => {
      action()
      await new Promise<void>((resolve) => setTimeout(resolve, spacing))
    })
  }

  const safeKill = (pty: PtyLike, signal: string | undefined): void => {
    try {
      pty.kill(signal)
    } catch {
      // Ya murió; la notificación de salida está en camino.
    }
  }

  return (raw) => {
    const parsed = parseHostRequest(raw)
    if (!parsed.ok) {
      deps.log(`mensaje inválido descartado (${parsed.error})`)
      return
    }
    const msg = parsed.value
    switch (msg.t) {
      case 'spawn': {
        if (terminals.has(msg.id)) {
          deps.send({ t: 'spawn-error', id: msg.id, message: 'id de terminal repetido' })
          return
        }
        try {
          const pty = deps.spawnPty({
            file: msg.file,
            args: msg.args,
            name: msg.name,
            cols: msg.cols,
            rows: msg.rows,
            cwd: msg.cwd,
            env: msg.env,
            conptyDll: msg.conptyDll,
          })
          const entry: Entry = { pty, exited: false, killRequested: false }
          terminals.set(msg.id, entry)
          deps.send({ t: 'spawned', id: msg.id, pid: pty.pid })
          pty.onData((data) => deps.send({ t: 'data', id: msg.id, data }))
          pty.onExit((e) => {
            entry.exited = true
            terminals.delete(msg.id)
            // node-pty (ConPTY) puede llamar a onExit sin código ni señal numéricos; si el evento se enviara
            // así, el daemon lo descartaría por inválido y la terminal nunca saldría (issue #37).
            const exitCode =
              typeof e.exitCode === 'number' && Number.isSafeInteger(e.exitCode) ? e.exitCode : null
            const signal =
              typeof e.signal === 'number' && Number.isSafeInteger(e.signal) ? e.signal : null
            if (exitCode === null && signal === null) {
              deps.log(`la terminal ${msg.id} salió sin código de salida (${String(e.exitCode)})`)
            }
            deps.send({ t: 'exit', id: msg.id, exitCode, signal })
          })
        } catch (error) {
          deps.send({
            t: 'spawn-error',
            id: msg.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
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
        if (isWindows) {
          spacedKill(() => {
            if (!entry.exited) safeKill(entry.pty, undefined)
          })
        } else {
          safeKill(entry.pty, msg.signal ?? 'SIGTERM')
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
        void killGate.then(() => setTimeout(deps.exit, 200))
        return
      }
    }
  }
}
