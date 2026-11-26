import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RenewTokens } from '@nexo/contracts'
import { z } from 'zod'

/**
 * Ajustes de la memoria guardados desde la interfaz (`memory.configure`, F3.5.4): `<estado>/memory-settings.json`.
 * Mandan sobre `NEXO_MEMORY` y `NEXO_MEMORY_RENEW_TOKENS`; el resumidor y los umbrales siguen siendo de entorno.
 * Un archivo ilegible o con otra versión se ignora (se vuelve al entorno) sin impedir arrancar.
 */
const MemorySettingsFile = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean().optional(),
  /** `null`: la renovación automática se apagó a propósito aunque el entorno la fije. */
  renewAtTokens: RenewTokens.nullable().optional(),
})
export type MemorySettingsFile = z.infer<typeof MemorySettingsFile>

const MAX_BYTES = 4096

export const memorySettingsPath = (stateDir: string): string =>
  join(stateDir, 'memory-settings.json')

export async function loadMemorySettings(
  stateDir: string,
  onInvalid?: (reason: string) => void,
): Promise<MemorySettingsFile | undefined> {
  let raw: string
  try {
    raw = await readFile(memorySettingsPath(stateDir), 'utf8')
  } catch {
    return undefined
  }
  try {
    if (raw.length > MAX_BYTES) throw new Error('demasiado grande')
    return MemorySettingsFile.parse(JSON.parse(raw))
  } catch (error) {
    onInvalid?.(error instanceof Error ? error.message.slice(0, 200) : 'inválido')
    return undefined
  }
}

/** Escritura atómica (archivo temporal y `rename`), con permisos solo del usuario. */
export async function saveMemorySettings(
  stateDir: string,
  settings: { enabled: boolean; renewAtTokens: number | undefined },
): Promise<void> {
  const file: MemorySettingsFile = {
    version: 1,
    enabled: settings.enabled,
    renewAtTokens: settings.renewAtTokens ?? null,
  }
  const target = memorySettingsPath(stateDir)
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 })
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}
