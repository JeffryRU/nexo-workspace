/**
 * Puerto `Notifier` del lado de la interfaz: notificaciones del sistema. Hay tres adaptadores: la API
 * `Notification` del navegador, el plugin oficial de Tauri 2 (escritorio) y uno nulo (sin soporte). Las pruebas
 * usan `FakeNotifier` (`fake-notifier.ts`).
 */
export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export type NoticeContent = {
  title: string
  body: string
  /** Notificaciones con la misma etiqueta se reemplazan entre sí (el sistema no las apila). */
  tag: string
}

export interface Notifier {
  /**
   * `true` si el sistema avisa al hacer clic en la notificación. El plugin de Tauri en escritorio no lo hace
   * (su API de acciones es solo móvil): la interfaz lo compensa al recuperar el foco.
   */
  readonly supportsClick: boolean
  permission(): Promise<NotifyPermission>
  /** Pide permiso. Solo debe llamarse tras un gesto del usuario (los navegadores lo exigen). */
  request(): Promise<NotifyPermission>
  /** Muestra la notificación; `onClick` se llama si el usuario la pulsa (solo con `supportsClick`). */
  notify(content: NoticeContent, onClick: () => void): void
}

export const nullNotifier: Notifier = {
  supportsClick: false,
  permission: async () => 'unsupported',
  request: async () => 'unsupported',
  notify: () => {},
}

function toPermission(value: unknown): NotifyPermission {
  return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported'
}

/** Lo mínimo de la API `Notification` del navegador que usa el adaptador. */
export type NotificationCtor = {
  new (
    title: string,
    options?: { body?: string; tag?: string },
  ): { onclick: ((event: unknown) => void) | null; close(): void }
  readonly permission: string
  requestPermission(): Promise<string>
}

export type WebNotifierEnv = {
  Notification?: NotificationCtor
  focus?: () => void
}

/** Navegador: API `Notification`. Si no existe, el permiso es `unsupported`. */
export function webNotifier(env: WebNotifierEnv): Notifier {
  const ctor = env.Notification
  if (ctor === undefined) return nullNotifier
  return {
    supportsClick: true,
    permission: async () => toPermission(ctor.permission),
    async request() {
      try {
        return toPermission(await ctor.requestPermission())
      } catch {
        return 'denied'
      }
    },
    notify(content, onClick) {
      if (ctor.permission !== 'granted') return
      try {
        const n = new ctor(content.title, { body: content.body, tag: content.tag })
        n.onclick = () => {
          n.close()
          env.focus?.()
          onClick()
        }
      } catch {
        // algunos entornos (Android, WebViews) lanzan al construirla: no hay nada que hacer
      }
    },
  }
}

export type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Escritorio: plugin oficial `tauri-plugin-notification`, por `invoke` (no hay dependencia de JS: la página no
 * importa paquetes de Tauri). Los comandos son los tres que concede la capability: `is_permission_granted`,
 * `request_permission` y `notify`.
 */
export function tauriNotifier(invoke: TauriInvoke): Notifier {
  return {
    supportsClick: false,
    async permission() {
      try {
        const granted = await invoke('plugin:notification|is_permission_granted')
        // `null`: el sistema todavía no lo decidió.
        return granted === true ? 'granted' : granted === false ? 'denied' : 'default'
      } catch {
        return 'unsupported'
      }
    },
    async request() {
      try {
        return toPermission(await invoke('plugin:notification|request_permission'))
      } catch {
        return 'unsupported'
      }
    },
    notify(content) {
      void invoke('plugin:notification|notify', {
        options: { title: content.title, body: content.body },
      }).catch(() => {})
    },
  }
}

type TauriGlobal = { core?: { invoke?: TauriInvoke }; invoke?: TauriInvoke }

/** Tauri si la página corre dentro del shell de escritorio; si no, el navegador. */
export function detectNotifier(win: WebNotifierEnv & { __TAURI__?: unknown }): Notifier {
  const tauri = win.__TAURI__ as TauriGlobal | undefined
  const invoke = tauri?.core?.invoke ?? tauri?.invoke
  if (typeof invoke === 'function') return tauriNotifier(invoke)
  return webNotifier(win)
}
