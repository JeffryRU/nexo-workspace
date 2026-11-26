import type { ProviderEvent } from '@nexo/contracts'
import { AcpTranslator } from '../src/translator.ts'

export const SESSION = 'sess-1'

/** `params` de una notificación `session/update`. */
export const upd = (update: Record<string, unknown>) => ({ sessionId: SESSION, update })

export const message = (text: string) =>
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
export const thought = (text: string) =>
  upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
export const toolCall = (fields: Record<string, unknown>) =>
  upd({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Herramienta', ...fields })
export const toolUpdate = (fields: Record<string, unknown>) =>
  upd({ sessionUpdate: 'tool_call_update', toolCallId: 't1', ...fields })
export const plan = (entries: { content: string; status: string }[]) =>
  upd({
    sessionUpdate: 'plan',
    entries: entries.map((e) => ({ priority: 'medium', ...e })),
  })

export function newTranslator(mapMode?: (id: string) => 'ask' | 'plan' | undefined) {
  let n = 0
  const t = new AcpTranslator({ nextRef: () => `r${++n}`, ...(mapMode ? { mapMode } : {}) })
  return t
}

/** Un turno: alimenta las notificaciones y devuelve todos los eventos (sin cerrar el turno). */
export function run(notes: unknown[]): ProviderEvent[] {
  const t = newTranslator()
  t.beginTurn()
  return notes.flatMap((n) => t.notification(n))
}

export const types = (events: ProviderEvent[]) => events.map((e) => e.type)
export const deltaText = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'block-delta' && e.field === 'text' ? [e.text] : [])).join('')
