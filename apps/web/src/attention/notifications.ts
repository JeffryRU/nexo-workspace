import { createSignal } from 'solid-js'
import { es } from '../i18n/es.ts'
import type { Settings } from '../state/settings.ts'
import type { Notifier, NotifyPermission } from './notifier.ts'

export type NotificationsState = 'off' | 'on' | 'blocked'

/** Estado y orden del usuario sobre las notificaciones: ajuste persistente + permiso del sistema. */
export function createNotifications(deps: {
  notifier: Notifier
  settings: Settings
  showError: (message: string) => void
}) {
  const { notifier, settings } = deps
  const [permission, setPermission] = createSignal<NotifyPermission>('default')
  void notifier.permission().then(setPermission, () => setPermission('unsupported'))

  /** Se avisa de verdad solo con el ajuste activo y el permiso concedido. */
  const enabled = () => settings.notifications() && permission() === 'granted'

  return {
    notifier,
    enabled,
    permission,
    state: (): NotificationsState =>
      !settings.notifications() ? 'off' : permission() === 'granted' ? 'on' : 'blocked',
    /**
     * Activa o desactiva. Activar pide el permiso (debe colgar de un gesto del usuario: un clic o una tecla) y, si
     * el sistema lo niega, el ajuste queda desactivado y se explica.
     */
    async toggle(): Promise<void> {
      if (settings.notifications()) {
        settings.setNotifications(false)
        return
      }
      let next: NotifyPermission
      try {
        next = permission() === 'granted' ? 'granted' : await notifier.request()
      } catch {
        next = 'denied'
      }
      setPermission(next)
      if (next === 'granted') settings.setNotifications(true)
      else
        deps.showError(
          next === 'unsupported' ? es.notifications.unsupported : es.notifications.denied,
        )
    },
  }
}

export type Notifications = ReturnType<typeof createNotifications>
