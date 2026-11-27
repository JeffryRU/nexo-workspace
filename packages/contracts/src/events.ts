import { z } from 'zod'
import { AgentDelta, AgentSession, Block } from './agent.ts'
import {
  AgentSessionId,
  Attention,
  LayoutSchema,
  Pane,
  PaneId,
  TabId,
  TerminalId,
  WorkspaceId,
} from './domain.ts'
import { LIMITS } from './limits.ts'
import { DisplayText, lineText } from './text.ts'
import { ProviderLimits } from './usage-limits.ts'

/** Pestaña resumida (sin distribución ni paneles) para `workspace.changed`. */
export const TabSummary = z.strictObject({ id: TabId, title: DisplayText })
export type TabSummary = z.infer<typeof TabSummary>

/** Espacio con sus pestañas resumidas. */
export const WorkspaceSummary = z.strictObject({
  id: WorkspaceId,
  name: DisplayText,
  cwd: z.string().min(1).max(LIMITS.maxPathLength).optional(),
  activeTabId: TabId.optional(),
  tabs: z.array(TabSummary).max(1024),
})
export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>

/** Registro de eventos de la F1: nombre -> esquema de `data`. */
export const events = {
  'layout.changed': z.strictObject({
    workspaceId: WorkspaceId,
    tabId: TabId,
    /** `null` cuando la pestaña se cerró. */
    layout: LayoutSchema.nullable(),
    focusedPaneId: PaneId.nullable(),
    panes: z.array(Pane).max(LIMITS.maxPanesPerTab),
  }),
  'terminal.output': z.strictObject({
    terminalId: TerminalId,
    /** Posición (en bytes de salida acumulados) del final del fragmento. */
    offset: z.int().nonnegative(),
    data: z.string().max(LIMITS.maxMessageBytes),
  }),
  'terminal.exit': z.strictObject({
    terminalId: TerminalId,
    exitCode: z.int().nullable(),
    signal: z.string().max(32).nullable(),
  }),
  'pane.title': z.strictObject({ paneId: PaneId, title: DisplayText }),
  'pane.attention': z.strictObject({ paneId: PaneId, attention: Attention }),
  /**
   * Alta, renombre o cambio de pestañas de un espacio (o su cierre, con `removed: true`).
   * Cubre lo que `layout.changed` no dice: nombres de espacio y de pestaña, y espacios nuevos o cerrados.
   */
  'workspace.changed': z.union([
    z.strictObject({ workspace: WorkspaceSummary }),
    z.strictObject({ workspaceId: WorkspaceId, removed: z.literal(true) }),
  ]),
  /**
   * El daemon descartó eventos `terminal.output` de este cliente porque no leía a tiempo (contrapresión).
   * El cliente debe pedir `snapshot` y `terminal.read` con `fromOffset` para recuperar lo perdido.
   */
  'client.resync': z.strictObject({
    reason: z.literal('backpressure'),
    dropped: z.int().positive(),
  }),
  /** Un bloque nuevo o uno que reemplaza al de su `id` (el cliente hace upsert por `block.id`). */
  'agent.block': z.strictObject({ sessionId: AgentSessionId, block: Block }),
  /**
   * Texto añadido a un bloque en streaming. `seq` cuenta los deltas del bloque; un cliente aplica el
   * siguiente al `block.seq` que tiene, ignora los repetidos y ante un hueco pide `agent.snapshot`.
   */
  'agent.delta': AgentDelta,
  /** Cambio de estado de atención de una sesión (también alimenta `pane.attention`). */
  'agent.status': z.strictObject({
    sessionId: AgentSessionId,
    status: Attention,
    updatedAt: z.int().nonnegative(),
    /** Motivo breve si `status` es `error` o `needs-input`. */
    reason: lineText(LIMITS.maxErrorMessageLength).optional(),
  }),
  /** Alta o cambio de la sesión (modelo real, ficha, título...) o su cierre (`removed: true`). */
  'agent.session': z.union([
    z.strictObject({ session: AgentSession }),
    z.strictObject({ sessionId: AgentSessionId, removed: z.literal(true) }),
  ]),
  /**
   * La memoria de un proyecto cambió (F3.5.2): el Observador añadió observaciones o el Reflector reescribió el
   * registro. Solo avisa; el cliente pide `memory.list` para ver el contenido.
   */
  'memory.updated': z.strictObject({
    /** Carpeta normalizada del proyecto (la clave de `memory.list`). */
    cwd: z.string().min(1).max(LIMITS.maxPathLength),
    kind: z.enum(['observe', 'reflect']),
    observations: z.int().nonnegative(),
    generation: z.int().nonnegative(),
    updatedAt: z.int().nonnegative(),
  }),
  /** Los límites de uso de un proveedor cambiaron (F4.4): el cliente sustituye lo que tenía de ese proveedor. */
  'limits.updated': ProviderLimits,
} as const

export type EventName = keyof typeof events
export const EVENT_NAMES = Object.keys(events) as [EventName, ...EventName[]]
export const EventNameSchema = z.enum(EVENT_NAMES)
export type EventData<E extends EventName> = z.infer<(typeof events)[E]>

/** Evento ya tipado: unión discriminada por `event`. */
export type TypedEvent = {
  [E in EventName]: { v: 1; event: E; seq: number; data: EventData<E> }
}[EventName]
