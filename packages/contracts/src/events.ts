import { z } from 'zod'
import { Attention, LayoutSchema, Pane, PaneId, TabId, TerminalId, WorkspaceId } from './domain.ts'
import { LIMITS } from './limits.ts'
import { DisplayText } from './text.ts'

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
} as const

export type EventName = keyof typeof events
export const EVENT_NAMES = Object.keys(events) as [EventName, ...EventName[]]
export const EventNameSchema = z.enum(EVENT_NAMES)
export type EventData<E extends EventName> = z.infer<(typeof events)[E]>

/** Evento ya tipado: unión discriminada por `event`. */
export type TypedEvent = {
  [E in EventName]: { v: 1; event: E; seq: number; data: EventData<E> }
}[EventName]
