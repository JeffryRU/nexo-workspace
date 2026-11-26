import { z } from 'zod'
import {
  AgentRespondParams,
  AgentSession,
  Block,
  PermissionMode,
  ProviderId,
  ProviderInfo,
  ProviderSessionToken,
  Token,
} from './agent.ts'
import {
  AgentSessionId,
  BlockId,
  LayoutSchema,
  Pane,
  PaneId,
  PaneKind,
  SplitDirection,
  Tab,
  TabId,
  TerminalId,
  Workspace,
  WorkspaceId,
} from './domain.ts'
import { EventNameSchema } from './events.ts'
import { LIMITS } from './limits.ts'
import { memoryMethods } from './memory.ts'
import { bodyText, boundedBytes, DisplayText, FORBIDDEN_KEYS } from './text.ts'

const Empty = z.strictObject({})
const Ok = z.strictObject({})
const Path = z.string().min(1).max(LIMITS.maxPathLength)
const Cols = z.int().min(LIMITS.minTerminalSize).max(LIMITS.maxTerminalSize)
const Rows = Cols

const EnvName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((k) => !FORBIDDEN_KEYS.has(k), { message: 'nombre reservado' })
const Env = z
  .record(EnvName, z.string().max(LIMITS.maxEnvValueLength))
  .refine((o) => Object.keys(o).length <= LIMITS.maxEnvEntries, { message: 'demasiadas variables' })

const ResizeDelta = z.number().min(-1).max(1)

/** Frontera de un panel con su hermano directo (forma original). */
const ResizeByPane = z.strictObject({ paneId: PaneId, delta: ResizeDelta })

/**
 * Frontera por camino de nodo: `path` son los índices de hijo desde la raíz hasta un split de la pestaña
 * (vacío = la raíz) e `index` es el hijo cuya frontera con el siguiente se mueve; delta > 0 agranda ese hijo.
 * Cualquier divisor del árbol (entre hojas o subárboles) queda así identificado sin ambigüedad.
 */
const ResizeByPath = z.strictObject({
  tabId: TabId,
  path: z
    .array(
      z
        .int()
        .min(0)
        .max(LIMITS.maxPanesPerTab - 1),
    )
    .max(LIMITS.maxLayoutPathDepth),
  index: z
    .int()
    .min(0)
    .max(LIMITS.maxPanesPerTab - 2),
  delta: ResizeDelta,
})

const Signal = z.enum(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP'])

/**
 * Registro de métodos de la F1: nombre -> { params, result }.
 * El servidor y el cliente se derivan de este registro.
 */
export const methods = {
  /** Primer mensaje de una conexión sin token en el subprotocolo; el daemon lo resuelve antes de despachar. */
  auth: {
    params: z.strictObject({ token: z.string().max(4096) }),
    result: Ok,
  },
  'daemon.info': {
    params: Empty,
    result: z.strictObject({
      version: z.string().min(1).max(64),
      protocol: z.literal(1),
      pid: z.int().nonnegative(),
      startedAt: z.string().max(40),
    }),
  },
  /** Apagado limpio: responde y luego el daemon se detiene. Solo clientes autenticados llegan al despachador. */
  'daemon.shutdown': { params: Empty, result: Ok },
  snapshot: {
    params: Empty,
    result: z.strictObject({
      /** `seq` del último evento incluido en el estado. */
      seq: z.int().nonnegative(),
      workspaces: z.array(Workspace).max(1024),
    }),
  },
  'events.subscribe': {
    params: z.strictObject({ events: z.array(EventNameSchema).max(32).optional() }),
    result: z.strictObject({ seq: z.int().nonnegative() }),
  },
  'workspace.list': { params: Empty, result: z.strictObject({ workspaces: z.array(Workspace) }) },
  'workspace.create': {
    params: z.strictObject({ name: DisplayText, cwd: Path.optional() }),
    result: z.strictObject({ workspace: Workspace }),
  },
  'workspace.rename': {
    params: z.strictObject({ workspaceId: WorkspaceId, name: DisplayText }),
    result: Ok,
  },
  'workspace.close': { params: z.strictObject({ workspaceId: WorkspaceId }), result: Ok },
  'tab.create': {
    params: z.strictObject({
      workspaceId: WorkspaceId,
      title: DisplayText.optional(),
      cwd: Path.optional(),
    }),
    result: z.strictObject({ tab: Tab }),
  },
  'tab.close': { params: z.strictObject({ tabId: TabId }), result: Ok },
  'tab.focus': { params: z.strictObject({ tabId: TabId }), result: Ok },
  'tab.move': {
    params: z.strictObject({
      tabId: TabId,
      workspaceId: WorkspaceId.optional(),
      index: z.int().nonnegative().max(1023),
    }),
    result: Ok,
  },
  'tab.rename': { params: z.strictObject({ tabId: TabId, title: DisplayText }), result: Ok },
  'pane.split': {
    params: z.strictObject({
      paneId: PaneId,
      direction: SplitDirection,
      kind: PaneKind.optional(),
      ratio: z.number().gt(0).lt(1).optional(),
    }),
    result: z.strictObject({ pane: Pane, layout: LayoutSchema }),
  },
  'pane.close': { params: z.strictObject({ paneId: PaneId }), result: Ok },
  'pane.focus': { params: z.strictObject({ paneId: PaneId }), result: Ok },
  'pane.resize': {
    params: z.union([ResizeByPane, ResizeByPath]),
    result: z.strictObject({ layout: LayoutSchema }),
  },
  'pane.swap': {
    params: z.strictObject({ paneId: PaneId, otherPaneId: PaneId }),
    result: z.strictObject({ layout: LayoutSchema }),
  },
  'terminal.spawn': {
    params: z.strictObject({
      paneId: PaneId,
      cmd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
      args: z.array(z.string().max(LIMITS.maxArgLength)).max(LIMITS.maxArgs).optional(),
      cwd: Path.optional(),
      env: Env.optional(),
      cols: Cols,
      rows: Rows,
    }),
    result: z.strictObject({ terminalId: TerminalId }),
  },
  'terminal.write': {
    params: z.strictObject({ terminalId: TerminalId, data: boundedBytes(LIMITS.maxWriteBytes) }),
    result: Ok,
  },
  'terminal.resize': {
    params: z.strictObject({ terminalId: TerminalId, cols: Cols, rows: Rows }),
    result: Ok,
  },
  'terminal.read': {
    params: z.strictObject({
      terminalId: TerminalId,
      maxBytes: z.int().min(1).max(LIMITS.maxReadBytes).optional(),
      /** Offset absoluto desde el que leer; sin él, devuelve lo más reciente (hasta `maxBytes`). */
      fromOffset: z.int().nonnegative().optional(),
    }),
    result: z.strictObject({
      data: z.string().max(LIMITS.maxMessageBytes),
      /** Offset absoluto del final de `data`: el siguiente `fromOffset` para no perder ni duplicar. */
      offset: z.int().nonnegative(),
      /** `true` si `fromOffset` ya se había descartado del búfer y `data` empieza en lo más antiguo disponible. */
      truncated: z.boolean().optional(),
    }),
  },
  'terminal.kill': {
    params: z.strictObject({ terminalId: TerminalId, signal: Signal.optional() }),
    result: Ok,
  },
  'agent.providers': {
    params: Empty,
    result: z.strictObject({ providers: z.array(ProviderInfo).max(32) }),
  },
  'agent.create': {
    params: z.strictObject({
      paneId: PaneId,
      provider: ProviderId,
      cwd: Path.optional(),
      model: Token.optional(),
      effort: Token.optional(),
      permissionMode: PermissionMode.optional(),
      /** Reanuda la sesión del proveedor con esta ficha (`providerSessionId`). */
      resume: ProviderSessionToken.optional(),
    }),
    result: z.strictObject({ session: AgentSession }),
  },
  'agent.send': {
    params: z.strictObject({
      sessionId: AgentSessionId,
      text: bodyText(LIMITS.maxBlockTextBytes, 1),
    }),
    /** El bloque `user` ya añadido al documento. */
    result: z.strictObject({
      blockId: BlockId,
      index: z.int().nonnegative(),
      turn: z.int().positive(),
    }),
  },
  'agent.interrupt': { params: z.strictObject({ sessionId: AgentSessionId }), result: Ok },
  'agent.respond': { params: AgentRespondParams, result: Ok },
  'agent.list': {
    params: Empty,
    result: z.strictObject({ sessions: z.array(AgentSession).max(LIMITS.maxAgentSessions) }),
  },
  /**
   * Página del documento: bloques con `index >= fromIndex` (0 por omisión), hasta `limit`. `nextIndex` es el
   * `fromIndex` de la página siguiente, o `null` al llegar al final. El daemon puede devolver menos bloques
   * que `limit` para no pasar de `maxMessageBytes`. Un cliente que ve un hueco de `seq` o `agent.delta`
   * fuera de orden vuelve a pedir desde el `index` del bloque afectado.
   */
  'agent.snapshot': {
    params: z.strictObject({
      sessionId: AgentSessionId,
      fromIndex: z.int().nonnegative().optional(),
      limit: z.int().min(1).max(LIMITS.maxSnapshotBlocks).optional(),
    }),
    result: z.strictObject({
      session: AgentSession,
      blocks: z.array(Block).max(LIMITS.maxSnapshotBlocks),
      nextIndex: z.int().nonnegative().nullable(),
    }),
  },
  'agent.close': { params: z.strictObject({ sessionId: AgentSessionId }), result: Ok },
  /**
   * Renueva la sesión a mano (F3.5.4): abre una sesión nueva del proveedor sembrada con la memoria y los
   * últimos turnos, y cierra la anterior. Misma pestaña, mismo `sessionId`. `CONFLICT` si hay un turno en
   * curso, ya se está renovando o no hay nada que sembrar; `PROVIDER_UNAVAILABLE` si el proveedor no admite memoria.
   */
  'agent.renew': {
    params: z.strictObject({ sessionId: AgentSessionId }),
    result: z.strictObject({ session: AgentSession }),
  },
  ...memoryMethods,
} as const

export type MethodName = keyof typeof methods
export const METHOD_NAMES = Object.keys(methods) as MethodName[]
export type MethodParams<M extends MethodName> = z.infer<(typeof methods)[M]['params']>
export type MethodResult<M extends MethodName> = z.infer<(typeof methods)[M]['result']>

/** Petición ya tipada: unión discriminada por `method`. */
export type TypedRequest = {
  [M in MethodName]: { v: 1; id: string; method: M; params: MethodParams<M> }
}[MethodName]
