import { CompanionLoader } from '@nexo/core'
import { FsCompanionSource, type FsCompanionSourceOptions } from './fs-companion-source.ts'

export { FsCompanionSource, type FsCompanionSourceOptions } from './fs-companion-source.ts'

/** `CompanionPort` real: paquetes de `<datos>/companions/<id>/` (ver `docs/ARCHITECTURE.md`, «Compañeros (F5.2)»). */
export function createFsCompanionPort(options: FsCompanionSourceOptions): CompanionLoader {
  return new CompanionLoader(new FsCompanionSource(options))
}
