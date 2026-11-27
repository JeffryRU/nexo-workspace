import { z } from 'zod'

export const DEFAULTS = {
  maxWriteBytes: 8 * 1024,
  writePerMinute: 30,
  readPerMinute: 300,
  maxOutputBytes: 32 * 1024,
} as const

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

const Flag = z
  .enum(['', '0', '1', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional()

const Int = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'debe ser un entero')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()

const EnvSchema = z.object({
  NEXO_MCP_WRITE: Flag,
  NEXO_MCP_ALLOW_PERMISSIONS: Flag,
  NEXO_MCP_MAX_WRITE_BYTES: Int(1, 64 * 1024),
  NEXO_MCP_WRITE_RATE: Int(1, 600),
  NEXO_MCP_READ_RATE: Int(1, 6000),
  NEXO_MCP_MAX_OUTPUT_BYTES: Int(1024, 256 * 1024),
})

export type McpConfig = {
  /** Herramientas de escritura (terminal_write, agent_create, agent_send, agent_interrupt) registradas. */
  write: boolean
  /** `agent_respond` (aprobar o rechazar permisos) registrada; exige `write`. */
  allowPermissions: boolean
  maxWriteBytes: number
  writePerMinute: number
  readPerMinute: number
  maxOutputBytes: number
}

/** Valida el entorno del servidor; un valor inválido aborta el arranque con un mensaje claro. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
  const picked: Record<string, string> = {}
  for (const key of Object.keys(EnvSchema.shape)) {
    const value = env[key]
    if (value !== undefined) picked[key] = value
  }
  const parsed = EnvSchema.safeParse(picked)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const name = String(issue?.path[0] ?? 'entorno')
    throw new ConfigError(`${name} no es válido: ${issue?.message ?? 'valor inesperado'}`)
  }
  const v = parsed.data
  const write = v.NEXO_MCP_WRITE ?? false
  const allowPermissions = v.NEXO_MCP_ALLOW_PERMISSIONS ?? false
  if (allowPermissions && !write) {
    throw new ConfigError('NEXO_MCP_ALLOW_PERMISSIONS exige NEXO_MCP_WRITE=1')
  }
  return {
    write,
    allowPermissions,
    maxWriteBytes: v.NEXO_MCP_MAX_WRITE_BYTES ?? DEFAULTS.maxWriteBytes,
    writePerMinute: v.NEXO_MCP_WRITE_RATE ?? DEFAULTS.writePerMinute,
    readPerMinute: v.NEXO_MCP_READ_RATE ?? DEFAULTS.readPerMinute,
    maxOutputBytes: v.NEXO_MCP_MAX_OUTPUT_BYTES ?? DEFAULTS.maxOutputBytes,
  }
}
