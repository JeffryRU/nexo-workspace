/** Colores de xterm (One Dark Pro Night Flat); las variables CSS de la interfaz usan la misma paleta. */
export const terminalTheme = {
  background: '#15181d',
  foreground: '#abb2bf',
  cursor: '#61afef',
  cursorAccent: '#15181d',
  selectionBackground: '#3e4451',
  black: '#1e2127',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
} as const

/** Respaldo para los íconos de Nerd Font del prompt (Starship, etc.) cuando la fuente principal no los trae. */
const SYMBOLS_FALLBACK = ['"Symbols Nerd Font Mono"', '"Symbols Nerd Font"']

/** Agrega las fuentes de símbolos de Nerd Font a la lista, antes de la genérica `monospace`. Idempotente. */
export function withSymbolsFallback(family: string): string {
  const parts = family
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  const missing = SYMBOLS_FALLBACK.filter(
    (f) =>
      !parts.some(
        (p) => p.replace(/['"]/g, '').toLowerCase() === f.replace(/"/g, '').toLowerCase(),
      ),
  )
  const generic = parts.lastIndexOf('monospace')
  const at = generic === -1 ? parts.length : generic
  parts.splice(at, 0, ...missing)
  return parts.join(', ')
}
