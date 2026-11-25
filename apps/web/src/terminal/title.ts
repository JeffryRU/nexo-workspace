export type PaneTitle = {
  /** Lo que se muestra en el encabezado del panel. */
  label: string
  /** Título completo, para el tooltip. */
  full: string
}

// Ruta absoluta de Windows (unidad o UNC) que termina en un ejecutable: lo que ConPTY publica como título
// inicial cuando el shell todavía no puso el suyo (p. ej. `C:\Program Files\...\pwsh.exe`).
const WINDOWS_EXECUTABLE =
  /^(?:[A-Za-z]:|\\\\[^\\/]+)[\\/](?:.*[\\/])?([^\\/]+)\.(?:exe|cmd|bat|com)$/i

const MAX_PATH = 1024
const CONTROL = /\p{Cc}/gu

/**
 * Título de un panel para mostrar. Solo las rutas de ejecutables de Windows se acortan al nombre corto
 * (`pwsh`); cualquier otro título, incluido el que un programa pone con OSC 0/2, se respeta tal cual (sin
 * caracteres de control). Es presentación: el daemon no cambia el título.
 */
export function paneTitle(raw: string): PaneTitle {
  const full = raw.replace(CONTROL, ' ').trim()
  const unquoted = full.replace(/^"(.*)"$/, '$1')
  // Una ruta real no pasa de ~260 caracteres: más es otra cosa y no se analiza.
  const name = unquoted.length > MAX_PATH ? undefined : WINDOWS_EXECUTABLE.exec(unquoted)?.[1]
  return { label: name === undefined || name === '' ? full : name, full }
}
