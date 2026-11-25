import type { NoticeContent, Notifier, NotifyPermission } from './notifier.ts'

export type SentNotice = NoticeContent & { click: () => void }

/** Notificador falso para pruebas: guarda lo que se mostraría y deja simular el clic. */
export class FakeNotifier implements Notifier {
  supportsClick: boolean
  current: NotifyPermission
  /** Permiso que concede `request()`. */
  onRequest: NotifyPermission = 'granted'
  readonly sent: SentNotice[] = []
  requests = 0

  constructor(options: { supportsClick?: boolean; permission?: NotifyPermission } = {}) {
    this.supportsClick = options.supportsClick ?? true
    this.current = options.permission ?? 'granted'
  }

  async permission(): Promise<NotifyPermission> {
    return this.current
  }

  async request(): Promise<NotifyPermission> {
    this.requests++
    if (this.current === 'default') this.current = this.onRequest
    return this.current
  }

  notify(content: NoticeContent, onClick: () => void): void {
    if (this.current !== 'granted') return
    this.sent.push({ ...content, click: onClick })
  }
}
