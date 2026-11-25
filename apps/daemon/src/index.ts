import { LayoutService } from '@nexo/core'

// TODO(F1): raiz de composicion: servidor HTTP/WS en 127.0.0.1, token, adaptadores reales.

export const DAEMON_VERSION = '0.0.0'

export type DaemonInfo = {
  name: 'nexo-daemon'
  version: string
  layoutService: typeof LayoutService
}

export function describeDaemon(): DaemonInfo {
  return { name: 'nexo-daemon', version: DAEMON_VERSION, layoutService: LayoutService }
}
