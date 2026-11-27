import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompanionId } from '@nexo/contracts'
import type { CompanionSelectionStore } from '@nexo/core'
import { z } from 'zod'

/**
 * Compañero elegido (`companion.select`, F5.2): `<estado>/companion-settings.json`. «Sin mascota» (`selected: null`)
 * es el valor por omisión: un archivo ausente, ilegible o de otra versión se ignora sin impedir arrancar.
 */
const CompanionSettingsFile = z.strictObject({
  version: z.literal(1),
  selected: CompanionId.nullable(),
})

const MAX_BYTES = 1024

export const companionSettingsPath = (stateDir: string): string =>
  join(stateDir, 'companion-settings.json')

export function fileCompanionSelection(
  stateDir: string,
  onInvalid?: (reason: string) => void,
): CompanionSelectionStore {
  const target = companionSettingsPath(stateDir)
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(target, 'utf8')
      } catch {
        return null
      }
      try {
        if (raw.length > MAX_BYTES) throw new Error('demasiado grande')
        return CompanionSettingsFile.parse(JSON.parse(raw)).selected
      } catch (error) {
        onInvalid?.(error instanceof Error ? error.message.slice(0, 200) : 'inválido')
        return null
      }
    },
    /** Escritura atómica (archivo temporal y `rename`), con permisos solo del usuario. */
    async save(id) {
      const file = { version: 1, selected: id }
      const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await writeFile(tmp, `${JSON.stringify(file)}\n`, { mode: 0o600 })
        await rename(tmp, target)
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        throw error
      }
    },
  }
}
