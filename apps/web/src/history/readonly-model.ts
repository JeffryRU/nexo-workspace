import type { Block } from '@nexo/contracts'
import { type Accessor, createMemo, createSignal } from 'solid-js'
import type { BlockModel } from '../agent/blocks.tsx'

/**
 * Modelo de bloques de una sesión antigua: solo lee. Hace que `BlockView` pinte una transcripción del historial con
 * el mismo render del panel de agente, pero sin nada que responda ni envíe: la sesión figura como cerrada, así que
 * los permisos y las preguntas que quedaron pendientes salen desactivados.
 */
export function createReadOnlyModel(blocks: Accessor<readonly Block[]>): BlockModel {
  const byId = createMemo(() => new Map(blocks().map((b) => [b.id as string, b])))
  const expanded = new Map<string, [Accessor<boolean>, (v: boolean) => void]>()
  const fold = (id: string) => {
    let s = expanded.get(id)
    if (s === undefined) {
      const [get, set] = createSignal(false)
      s = [get, set]
      expanded.set(id, s)
    }
    return s
  }
  return {
    block: (id: string) => () => byId().get(id),
    expanded: (id: string) => fold(id)[0],
    toggle: (id: string) => {
      const [get, set] = fold(id)
      set(!get())
    },
    removed: () => true,
    status: () => 'done',
    respondPermission: async () => false,
    respondQuestion: async () => false,
  }
}
