import type { MethodResult } from '@nexo/contracts'
import type { LayoutService } from './layout-service.ts'

export type DaemonIdentity = { version: string; pid: number; startedAt: string }

export type SnapshotServiceDeps = {
  layout: LayoutService
  identity: DaemonIdentity
  /** `seq` del último evento emitido (lo lleva el daemon); 0 si no hay. */
  currentSeq?: () => number
}

/** Casos de uso `snapshot` y `daemon.info`. */
export class SnapshotService {
  readonly #deps: SnapshotServiceDeps

  constructor(deps: SnapshotServiceDeps) {
    this.#deps = deps
  }

  snapshot(): MethodResult<'snapshot'> {
    return { seq: this.#deps.currentSeq?.() ?? 0, workspaces: this.#deps.layout.snapshot() }
  }

  daemonInfo(): MethodResult<'daemon.info'> {
    const { version, pid, startedAt } = this.#deps.identity
    return { version, protocol: 1, pid, startedAt }
  }
}
