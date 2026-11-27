import { createSignal } from 'solid-js'

export type SettingsStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const SETTINGS_KEY = 'nexo.settings'

/** Lo que se guarda (versionado por campos: lo desconocido o de otro tipo se ignora). */
export type StoredSettings = { notifications: boolean; companionHidden: boolean }

const DEFAULTS: StoredSettings = { notifications: false, companionHidden: false }

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
    const { notifications, companionHidden } = parsed as {
      notifications?: unknown
      companionHidden?: unknown
    }
    return {
      notifications: typeof notifications === 'boolean' ? notifications : false,
      companionHidden: typeof companionHidden === 'boolean' ? companionHidden : false,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/**
 * Ajustes de la interfaz que sobreviven a recargar: se guardan en el almacenamiento local del navegador o del
 * WebView (no hay todavía ajustes del lado del daemon). Si el almacenamiento falla, solo se pierde la memoria.
 */
export function createSettings(storage?: SettingsStorage) {
  const initial = readSettings(storage)
  const [notifications, setNotificationsSignal] = createSignal(initial.notifications)
  const [companionHidden, setCompanionHiddenSignal] = createSignal(initial.companionHidden)
  const save = (): void => {
    try {
      const value: StoredSettings = {
        notifications: notifications(),
        companionHidden: companionHidden(),
      }
      storage?.setItem(SETTINGS_KEY, JSON.stringify(value))
    } catch {
      // cuota o acceso bloqueado
    }
  }
  return {
    notifications,
    setNotifications(value: boolean): void {
      setNotificationsSignal(value)
      save()
    },
    /** La mascota se oculta (F5.3): es una preferencia de esta ventana, como las notificaciones. */
    companionHidden,
    setCompanionHidden(value: boolean): void {
      setCompanionHiddenSignal(value)
      save()
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
