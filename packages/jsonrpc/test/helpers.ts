import {
  type ConnectionOptions,
  type IncomingNotification,
  type IncomingRequest,
  JsonRpcConnection,
  type ProtocolIssue,
  type Timers,
} from '../src/index.ts'

export const realTimers: Timers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

export type Harness = {
  conn: JsonRpcConnection
  /** Líneas que la conexión escribió (ya con `\n`). */
  written: string[]
  /** Mensajes escritos, ya analizados. */
  sent: () => Record<string, unknown>[]
  requests: IncomingRequest[]
  notifications: IncomingNotification[]
  issues: ProtocolIssue[]
  closes: (Error | undefined)[]
}

/** Una conexión aislada, con todo lo que escribe y recibe a la vista. */
export function harness(options: Partial<ConnectionOptions> = {}): Harness {
  const h: Harness = {
    written: [],
    requests: [],
    notifications: [],
    issues: [],
    closes: [],
    sent: () => h.written.map((l) => JSON.parse(l) as Record<string, unknown>),
    conn: undefined as unknown as JsonRpcConnection,
  }
  h.conn = new JsonRpcConnection({
    write: (line) => {
      h.written.push(line)
    },
    timers: realTimers,
    onNotification: (n) => h.notifications.push(n),
    onIssue: (i) => h.issues.push(i),
    onClose: (r) => h.closes.push(r),
    ...options,
  })
  return h
}

/** Dos conexiones unidas por memoria (lo que una escribe lo recibe la otra). */
export function linked(a: Partial<ConnectionOptions> = {}, b: Partial<ConnectionOptions> = {}) {
  const ends: { left?: JsonRpcConnection; right?: JsonRpcConnection } = {}
  const left = new JsonRpcConnection({
    write: (line) => ends.right?.feed(line),
    timers: realTimers,
    ...a,
  })
  const right = new JsonRpcConnection({
    write: (line) => ends.left?.feed(line),
    timers: realTimers,
    ...b,
  })
  ends.left = left
  ends.right = right
  return { left, right }
}
