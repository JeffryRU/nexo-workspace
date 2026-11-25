export type ShortcutAction =
  | 'tab.new'
  | 'pane.close'
  | 'pane.split-right'
  | 'pane.split-down'
  | 'pane.focus-left'
  | 'pane.focus-right'
  | 'pane.focus-up'
  | 'pane.focus-down'
  | 'tab.next'
  | 'tab.prev'
  | 'tab.goto-1'
  | 'tab.goto-2'
  | 'tab.goto-3'
  | 'tab.goto-4'
  | 'tab.goto-5'
  | 'tab.goto-6'
  | 'tab.goto-7'
  | 'tab.goto-8'
  | 'tab.goto-9'
  | 'agent.new-tab'
  | 'agent.split-right'
  | 'terminal.search'
  | 'attention.next'
  | 'help.toggle'

/** Combinaciones por acción, p. ej. `Alt+Shift+T`. Editable: es un mapa plano. */
export type KeyMap = Record<ShortcutAction, string[]>

export const DEFAULT_KEYMAP: KeyMap = {
  'tab.new': ['Alt+Shift+T'],
  'pane.close': ['Alt+Shift+W'],
  'pane.split-right': ['Alt+Shift+D'],
  'pane.split-down': ['Alt+Shift+S'],
  'pane.focus-left': ['Alt+ArrowLeft'],
  'pane.focus-right': ['Alt+ArrowRight'],
  'pane.focus-up': ['Alt+ArrowUp'],
  'pane.focus-down': ['Alt+ArrowDown'],
  'tab.next': ['Ctrl+PageDown', 'Alt+PageDown'],
  'tab.prev': ['Ctrl+PageUp', 'Alt+PageUp'],
  'tab.goto-1': ['Alt+1'],
  'tab.goto-2': ['Alt+2'],
  'tab.goto-3': ['Alt+3'],
  'tab.goto-4': ['Alt+4'],
  'tab.goto-5': ['Alt+5'],
  'tab.goto-6': ['Alt+6'],
  'tab.goto-7': ['Alt+7'],
  'tab.goto-8': ['Alt+8'],
  'tab.goto-9': ['Alt+9'],
  'agent.new-tab': ['Alt+Shift+A'],
  'agent.split-right': ['Alt+Shift+E'],
  'terminal.search': ['Ctrl+Shift+F'],
  'attention.next': ['Alt+Shift+N'],
  'help.toggle': ['Ctrl+Shift+P', '?'],
}

export type KeyEventLike = {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/** Nombre canónico de la tecla principal, independiente de la distribución del teclado. */
function mainKey(e: KeyEventLike): string {
  const code = e.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return e.key.length === 1 ? e.key.toUpperCase() : e.key
}

/** `Ctrl+Alt+Shift+Meta+<tecla>`, con los modificadores en ese orden. */
export function comboOf(e: KeyEventLike): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(mainKey(e))
  return parts.join('+')
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta']

/** Normaliza el texto de una combinación (orden de modificadores, mayúsculas de la tecla). */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  const mods = MODIFIERS.filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()))
  const main = key.length === 1 ? key.toUpperCase() : key
  return [...mods, main].join('+')
}

/**
 * Combinaciones que siempre van a la shell: Ctrl+letra sin Alt (Ctrl+C, Ctrl+D, Ctrl+R, Ctrl+Z, Ctrl+L…),
 * Ctrl+[ y similares. Con Shift sí se pueden reservar para la interfaz.
 */
export function isShellReserved(e: KeyEventLike): boolean {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return false
  return /^[A-Z[\\\]^_@]$/.test(mainKey(e)) || e.key === 'Escape'
}

export function isReservedCombo(combo: string): boolean {
  const parts = normalizeCombo(combo).split('+')
  const key = parts[parts.length - 1] as string
  const mods = parts.slice(0, -1)
  return mods.length === 1 && mods[0] === 'Ctrl' && /^[A-Z[\\\]^_@]$/.test(key)
}

/** Descarta de un mapa de usuario las combinaciones reservadas por la shell o vacías. */
export function sanitizeKeyMap(custom: Partial<Record<ShortcutAction, string[]>>): KeyMap {
  const result: KeyMap = { ...DEFAULT_KEYMAP }
  for (const action of Object.keys(DEFAULT_KEYMAP) as ShortcutAction[]) {
    const mine = custom[action]
    if (mine === undefined) continue
    const ok = mine
      .filter((c) => typeof c === 'string' && c.length > 0 && c.length < 40)
      .map(normalizeCombo)
      .filter((c) => !isReservedCombo(c))
    result[action] = ok
  }
  return result
}

/** Acción de una pulsación, o `undefined` si debe ir a la terminal. */
export function matchShortcut(
  e: KeyEventLike,
  keymap: KeyMap,
  context: { inTerminal: boolean; inEditable: boolean },
): ShortcutAction | undefined {
  if (isShellReserved(e)) return undefined
  const combo = comboOf(e)
  // Teclas sin modificadores (p. ej. «?») solo cuando no se está escribiendo.
  const plain = !e.ctrlKey && !e.altKey && !e.metaKey
  if (plain && (context.inTerminal || context.inEditable)) return undefined
  for (const action of Object.keys(keymap) as ShortcutAction[]) {
    if ((keymap[action] ?? []).some((c) => normalizeCombo(c) === combo || c === combo)) {
      return action
    }
  }
  // «?» llega como Shift+/ en muchas distribuciones.
  if (plain && e.key === '?') {
    return (Object.keys(keymap) as ShortcutAction[]).find((a) => keymap[a].includes('?'))
  }
  return undefined
}

export const GOTO_ACTIONS: ShortcutAction[] = [
  'tab.goto-1',
  'tab.goto-2',
  'tab.goto-3',
  'tab.goto-4',
  'tab.goto-5',
  'tab.goto-6',
  'tab.goto-7',
  'tab.goto-8',
  'tab.goto-9',
]
