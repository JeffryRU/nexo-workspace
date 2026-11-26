import {
  type ErrorBody,
  LIMITS,
  METHOD_NAMES,
  type MemoryMethodName,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from '@nexo/contracts'
import { DomainError } from './errors.ts'
import type { SnapshotService } from './snapshot-service.ts'
import type { TerminalService } from './terminal-service.ts'
import type { WorkspaceService } from './workspace-service.ts'

/** Los métodos `agent.*`; los implementa el servicio de agentes (F2.2). */
export type AgentMethodName = Extract<MethodName, `agent.${string}`>
export type AgentHandlers = {
  [M in AgentMethodName]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>
}

/** Los métodos `memory.*`; los implementa `MemoryService` (F3.5.2). */
export type MemoryHandlers = {
  [M in MemoryMethodName]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>
}

export type DispatcherServices = {
  workspaces: WorkspaceService
  terminals: TerminalService
  snapshot: SnapshotService
  /**
   * `events.subscribe` depende de la conexión (el daemon guarda los filtros por cliente), así que
   * lo aporta quien despacha.
   */
  subscribe: (params: MethodParams<'events.subscribe'>) => MethodResult<'events.subscribe'>
  /** Sin él (daemon sin proveedores), todo `agent.*` responde `PROVIDER_UNAVAILABLE`. */
  agents?: AgentHandlers
  /** Sin él, todo `memory.*` responde `PROVIDER_UNAVAILABLE`. */
  memory?: MemoryHandlers
  /** Pide el apagado del daemon; debe volver enseguida (el apagado ocurre después de responder). */
  shutdown: () => void
}

/** Petición ya validada con zod: unión discriminada por `method`. */
export type DispatchRequest = {
  [M in MethodName]: { method: M; params: MethodParams<M> }
}[MethodName]

export type DispatchOutcome<M extends MethodName = MethodName> =
  | { ok: true; result: MethodResult<M> }
  | { ok: false; error: ErrorBody }

type Handlers = {
  [M in MethodName]: (params: MethodParams<M>) => MethodResult<M> | Promise<MethodResult<M>>
}

/** Tabla exhaustiva: si falta un método del registro, no compila. */
export function createHandlers(s: DispatcherServices): Handlers {
  const agents = (): AgentHandlers => {
    if (s.agents === undefined) {
      throw new DomainError('PROVIDER_UNAVAILABLE', 'no hay proveedores de agente configurados')
    }
    return s.agents
  }
  const memory = (): MemoryHandlers => {
    if (s.memory === undefined) {
      throw new DomainError('PROVIDER_UNAVAILABLE', 'la memoria no está disponible')
    }
    return s.memory
  }
  return {
    // La autenticación la resuelve quien despacha (daemon) antes de llegar aquí; ya autenticado es un no-op.
    auth: () => ({}),
    'daemon.info': () => s.snapshot.daemonInfo(),
    'daemon.shutdown': () => {
      s.shutdown()
      return {}
    },
    snapshot: () => s.snapshot.snapshot(),
    'events.subscribe': (p) => s.subscribe(p),
    'workspace.list': () => s.workspaces.list(),
    'workspace.create': (p) => s.workspaces.create(p),
    'workspace.rename': (p) => s.workspaces.rename(p),
    'workspace.close': (p) => s.workspaces.close(p),
    'tab.create': (p) => s.workspaces.createTab(p),
    'tab.close': (p) => s.workspaces.closeTab(p),
    'tab.focus': (p) => s.workspaces.focusTab(p),
    'tab.move': (p) => s.workspaces.moveTab(p),
    'tab.rename': (p) => s.workspaces.renameTab(p),
    'pane.split': (p) => s.workspaces.split(p),
    'pane.close': (p) => s.workspaces.closePane(p),
    'pane.focus': (p) => s.workspaces.focusPane(p),
    'pane.resize': (p) => s.workspaces.resizePane(p),
    'pane.swap': (p) => s.workspaces.swapPanes(p),
    'terminal.spawn': (p) => s.terminals.spawn(p),
    'terminal.write': (p) => s.terminals.write(p),
    'terminal.resize': (p) => s.terminals.resize(p),
    'terminal.read': (p) => s.terminals.read(p),
    'terminal.kill': (p) => s.terminals.kill(p),
    'agent.providers': (p) => agents()['agent.providers'](p),
    'agent.create': (p) => agents()['agent.create'](p),
    'agent.send': (p) => agents()['agent.send'](p),
    'agent.interrupt': (p) => agents()['agent.interrupt'](p),
    'agent.respond': (p) => agents()['agent.respond'](p),
    'agent.list': (p) => agents()['agent.list'](p),
    'agent.snapshot': (p) => agents()['agent.snapshot'](p),
    'agent.close': (p) => agents()['agent.close'](p),
    'agent.renew': (p) => agents()['agent.renew'](p),
    'memory.status': (p) => memory()['memory.status'](p),
    'memory.list': (p) => memory()['memory.list'](p),
    'memory.search': (p) => memory()['memory.search'](p),
    'memory.recall': (p) => memory()['memory.recall'](p),
    'memory.configure': (p) => memory()['memory.configure'](p),
  }
}

function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.message.slice(0, LIMITS.maxErrorMessageLength),
      ...(error.data === undefined ? {} : { data: error.data }),
    }
  }
  // Nunca se filtra el mensaje de un error inesperado al cliente.
  return { code: 'INTERNAL', message: 'error interno' }
}

/**
 * Despachador puro: recibe `{ method, params }` ya validados con zod, llama al caso de uso y
 * devuelve el resultado o un error con código. No lanza nunca.
 */
export function createDispatcher(services: DispatcherServices) {
  const handlers = createHandlers(services)
  const known = new Set<string>(METHOD_NAMES)

  return async function dispatch<M extends MethodName>(request: {
    method: M
    params: MethodParams<M>
  }): Promise<DispatchOutcome<M>> {
    const method: string = request.method
    if (!known.has(method)) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `método desconocido: ${method}` } }
    }
    try {
      const handler = handlers[request.method] as (
        params: MethodParams<M>,
      ) => MethodResult<M> | Promise<MethodResult<M>>
      return { ok: true, result: await handler(request.params) }
    } catch (error) {
      return { ok: false, error: toErrorBody(error) }
    }
  }
}

export type Dispatcher = ReturnType<typeof createDispatcher>
