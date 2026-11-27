import type { CompanionDetail, CompanionMime, CompanionSummary } from '@nexo/contracts'

export type CompanionErrorCode =
  /** No hay paquete con ese id, o el recurso no es uno de los que declara su manifiesto. */
  | 'NOT_FOUND'
  /** El paquete o el recurso incumple el formato (manifiesto, ruta, imagen, SVG, enlace simbólico...). */
  | 'INVALID'
  | 'TOO_LARGE'
  | 'IO'

export class CompanionError extends Error {
  readonly code: CompanionErrorCode

  constructor(code: CompanionErrorCode, message: string) {
    super(message)
    this.name = 'CompanionError'
    this.code = code
  }
}

/**
 * Origen de los paquetes de compañeros (F5.2). Solo lectura; la implementación real es `@nexo/adapter-companion-fs`
 * (`<datos>/companions/<id>/`). Los errores son `CompanionError`. Un paquete es datos: nada se ejecuta.
 */
export interface CompanionPort {
  /**
   * Paquetes con un manifiesto válido y sus recursos presentes y con tamaño admisible, más los que no lo son (con el
   * motivo). No lee el contenido de los recursos: eso lo hacen `get` y `readAsset`.
   */
  list(): Promise<{ companions: CompanionSummary[]; invalid: { id: string; reason: string }[] }>
  /** Valida el paquete entero (manifiesto, recursos, bytes mágicos, SVG, topes) y lo describe. */
  get(id: string): Promise<CompanionDetail>
  /** Bytes de un recurso declarado por el manifiesto, tras comprobar que es la imagen que dice ser. */
  readAsset(id: string, path: string): Promise<{ mime: CompanionMime; bytes: Uint8Array }>
}

/** Persistencia del compañero elegido; `null` es «sin mascota» (por omisión). */
export interface CompanionSelectionStore {
  load(): Promise<string | null>
  save(id: string | null): Promise<void>
}
