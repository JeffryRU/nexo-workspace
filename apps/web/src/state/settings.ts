import { createSignal } from 'solid-js'

export type SettingsStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const SETTINGS_KEY = 'nexo.settings'

/** Lo que se guarda (versionado por campos: lo desconocido o de otro tipo se ignora). */
export type StoredSettings = { notifications: boolean }

const DEFAULTS: StoredSettings = { notifications: false }

/** Lee los ajustes guardados; cualquier basura (JSON roto, tipos distintos) cae a los valores por omisión. */
export function readSettings(storage: SettingsStorage | undefined): StoredSettings {
  if (storage === undefined) return { ...DEFAULTS }
  try {
    const raw = storage.getItem(SETTINGS_KEY)
    if (raw === null) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...DEFAULTS }
    }
    const { notifications } = parsed as { notifications?: unknown }
    return { notifications: typeof notifications === 'boolean' ? notifications : false }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Ajustes de la interfaz que sobreviven a recargar: se guardan en el almacenamiento local del navegador o del
 * WebView (no hay todavía ajustes del lado del daemon). Si el almacenamiento falla, solo se pierde la memoria.
 */
export function createSettings(storage?: SettingsStorage) {
  const [notifications, setNotificationsSignal] = createSignal(readSettings(storage).notifications)
  return {
    notifications,
    setNotifications(value: boolean): void {
      setNotificationsSignal(value)
      try {
        storage?.setItem(SETTINGS_KEY, JSON.stringify({ notifications: value }))
      } catch {
        // cuota o acceso bloqueado
      }
    },
  }
}

export type Settings = ReturnType<typeof createSettings>

/** `localStorage` si se puede usar (puede lanzar con las cookies bloqueadas o en ventanas privadas). */
export function browserStorage(win: {
  localStorage?: SettingsStorage
}): SettingsStorage | undefined {
  try {
    return win.localStorage
  } catch {
    return undefined
  }
}
