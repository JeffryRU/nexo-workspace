export type DaemonInfo = { port: number; token: string }

export type InfoFailure = 'missing-token' | 'invalid-port' | 'invalid-token' | 'tauri-error'

export type DaemonInfoResult = { ok: true; info: DaemonInfo } | { ok: false; reason: InfoFailure }

/** Fuente de los datos de conexión: URL (navegador/dev) o comando de Tauri (escritorio). */
export interface DaemonInfoSource {
  getDaemonInfo(): Promise<DaemonInfoResult>
  /**
   * `true` si cada llamada redescubre puerto y token (escritorio: `daemon_info`), de modo que tras reiniciar
   * el daemon basta con volver a pedirlos. En el navegador es `false`: no hay forma segura de obtener el
   * token nuevo (ver docs/ARCHITECTURE.md, "Interfaz").
   */
  readonly rediscovers: boolean
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

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type BrowserWindowLike = {
  location: { search: string; pathname: string; hash: string }
  history: { replaceState(data: unknown, unused: string, url?: string): void }
  /** Solo `sessionStorage` (por pestaña); `localStorage` queda descartado a propósito. */
  sessionStorage?: StorageLike
}

export const SESSION_KEY = 'nexo.daemon'

function openStorage(win: BrowserWindowLike): StorageLike | undefined {
  try {
    return win.sessionStorage
  } catch {
    return undefined // acceso bloqueado (ventana privada, políticas)
  }
}

/** Lee lo guardado en la pestaña; cualquier basura se trata como «no hay nada» (y se valida de nuevo). */
function readStored(storage: StorageLike | undefined): DaemonInfoResult | undefined {
  if (storage === undefined) return undefined
  try {
    const raw = storage.getItem(SESSION_KEY)
    if (raw === null) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { port, token } = parsed as { port?: unknown; token?: unknown }
    const result = validateInfo(port, token)
    return result.ok ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * Navegador/dev: lee `?port=&t=` y borra el token de la barra de direcciones. El token se conserva solo en
 * memoria y en el `sessionStorage` de esta pestaña (para sobrevivir a F5); nunca en localStorage ni en la URL.
 */
export function browserSource(win: BrowserWindowLike): DaemonInfoSource {
  let cached: DaemonInfoResult | undefined
  return {
    rediscovers: false,
    async getDaemonInfo() {
      if (cached !== undefined) return cached
      const params = new URLSearchParams(win.location.search)
      const token = params.get('t')
      const storage = openStorage(win)
      const stored = token === null ? readStored(storage) : undefined
      const urlPort = params.get('port')
      const port = urlPort ?? String(DEFAULT_PORT)
      // Sin token en la URL (F5 tras quitarlo) vale lo guardado en la pestaña si es del mismo puerto.
      const result =
        stored?.ok === true && (urlPort === null || Number(urlPort) === stored.info.port)
          ? stored
          : validateInfo(port, token)
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
      if (result.ok) {
        cached = result
        try {
          storage?.setItem(SESSION_KEY, JSON.stringify(result.info))
        } catch {
          // cuota o acceso bloqueado: solo se pierde la recuperación tras F5
        }
      }
      return result
    },
  }
}

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** Escritorio: el shell de Tauri entrega puerto y token con el comando `daemon_info`. */
export function tauriSource(invoke: TauriInvoke): DaemonInfoSource {
  return {
    rediscovers: true,
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
