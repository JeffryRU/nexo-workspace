export type DaemonInfo = { port: number; token: string }

export type InfoFailure = 'missing-token' | 'invalid-port' | 'invalid-token' | 'tauri-error'

export type DaemonInfoResult = { ok: true; info: DaemonInfo } | { ok: false; reason: InfoFailure }

/** Fuente de los datos de conexión: URL (navegador/dev) o comando de Tauri (escritorio). */
export interface DaemonInfoSource {
  getDaemonInfo(): Promise<DaemonInfoResult>
}

export const DEFAULT_PORT = 4317
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,512}$/

export function validateInfo(port: unknown, token: unknown): DaemonInfoResult {
  const p = typeof port === 'string' ? (/^\d{1,5}$/.test(port) ? Number(port) : Number.NaN) : port
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
    return { ok: false, reason: 'invalid-port' }
  }
  if (token === undefined || token === null || token === '') {
    return { ok: false, reason: 'missing-token' }
  }
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    return { ok: false, reason: 'invalid-token' }
  }
  return { ok: true, info: { port: p, token } }
}

export type BrowserWindowLike = {
  location: { search: string; pathname: string; hash: string }
  history: { replaceState(data: unknown, unused: string, url?: string): void }
}

/**
 * Navegador/dev: lee `?port=&t=` y borra el token de la barra de direcciones. El token solo vive en memoria
 * (el resultado se conserva para los reintentos); nunca se guarda en localStorage.
 */
export function browserSource(win: BrowserWindowLike): DaemonInfoSource {
  let cached: DaemonInfoResult | undefined
  return {
    async getDaemonInfo() {
      if (cached !== undefined) return cached
      const params = new URLSearchParams(win.location.search)
      const token = params.get('t')
      const port = params.get('port') ?? String(DEFAULT_PORT)
      const result = validateInfo(port, token)
      if (params.has('t')) {
        params.delete('t')
        const rest = params.toString()
        win.history.replaceState(
          null,
          '',
          `${win.location.pathname}${rest === '' ? '' : `?${rest}`}${win.location.hash}`,
        )
      }
      // Sin token no se cachea: quien abra la URL completa después debe poder reintentar.
      if (result.ok) cached = result
      return result
    },
  }
}

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** Escritorio: el shell de Tauri entrega puerto y token con el comando `daemon_info`. */
export function tauriSource(invoke: TauriInvoke): DaemonInfoSource {
  return {
    async getDaemonInfo() {
      try {
        const raw = await invoke('daemon_info')
        if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'tauri-error' }
        const { port, token } = raw as { port?: unknown; token?: unknown }
        return validateInfo(port, token)
      } catch {
        return { ok: false, reason: 'tauri-error' }
      }
    },
  }
}

type TauriGlobal = {
  core?: { invoke?: TauriInvoke }
  invoke?: TauriInvoke
}

/** Detecta en tiempo de ejecución si la página corre dentro de Tauri. */
export function detectSource(win: BrowserWindowLike & { __TAURI__?: unknown }): DaemonInfoSource {
  const tauri = win.__TAURI__ as TauriGlobal | undefined
  if (tauri !== undefined && tauri !== null) {
    const invoke = tauri.core?.invoke ?? tauri.invoke
    if (typeof invoke === 'function') return tauriSource(invoke)
  }
  return browserSource(win)
}
