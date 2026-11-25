const ALWAYS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']
const DEV = ['http://localhost:5173', 'http://127.0.0.1:5173']

/**
 * `Origin` permitido: la ventana de Tauri y, solo con `dev`, Vite. Sin cabecera `Origin`
 * (CLI, MCP) se permite; cualquier otro valor, incluido el literal `null`, se rechaza.
 */
export function isOriginAllowed(origin: string | string[] | undefined, dev: boolean): boolean {
  if (origin === undefined) return true
  if (typeof origin !== 'string') return false
  if (ALWAYS.includes(origin)) return true
  return dev && DEV.includes(origin)
}

/** Defensa contra DNS rebinding: el `Host` debe ser el propio loopback. */
export function isHostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  return ['127.0.0.1', 'localhost', '[::1]'].some((h) => lower === `${h}:${port}`)
}
