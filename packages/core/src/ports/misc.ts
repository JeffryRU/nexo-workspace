import type {
  AgentSessionId,
  BlockId,
  EventData,
  EventName,
  PaneId,
  TabId,
  TerminalId,
  Workspace,
  WorkspaceId,
} from '@nexo/contracts'
import type { Unsubscribe } from './pty.ts'

/** Publicación y suscripción de eventos del dominio (los nombres vienen de contracts). */
export type BusEvent = { [E in EventName]: { event: E; data: EventData<E> } }[EventName]

export interface EventBusPort {
  publish(event: BusEvent): void
  subscribe(listener: (event: BusEvent) => void): Unsubscribe
}

export interface ClockPort {
  /** Milisegundos desde la época Unix. */
  now(): number
  setTimeout(callback: () => void, ms: number): Unsubscribe
}

export interface IdPort {
  workspace(): WorkspaceId
  tab(): TabId
  pane(): PaneId
  terminal(): TerminalId
  agentSession(): AgentSessionId
  block(): BlockId
}

export type PersistedState = { version: 1; workspaces: Workspace[] }

export interface SessionStorePort {
  load(): Promise<PersistedState | null>
  save(state: PersistedState): Promise<void>
}

export type Notification = { title: string; body: string; paneId?: PaneId }

export interface NotifierPort {
  notify(notification: Notification): Promise<void>
}

export type LogFields = Readonly<Record<string, unknown>>

export interface LoggerPort {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

export type RunOptions = {
  cmd: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxOutputBytes?: number
}

export type RunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Procesos sin PTY (git, `claude --version`...). Siempre `cmd` + `args[]`, nunca cadena de shell. */
export interface ProcessLauncherPort {
  run(options: RunOptions): Promise<RunResult>
}
