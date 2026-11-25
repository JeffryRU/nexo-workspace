import { z } from 'zod'

const bool = z
  .enum(['0', '1', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true')

const EnvSchema = z.object({
  NEXO_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  NEXO_DEV: bool,
  NEXO_STATE_DIR: z.string().min(1).optional(),
  NEXO_PTY_MODE: z.enum(['host', 'direct']).optional(),
  NEXO_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  NEXO_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10000).default(128),
  NEXO_AUTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
})

export type DaemonEnv = {
  port: number
  dev: boolean
  stateDir: string | undefined
  /** `host`: PTY en un proceso hijo; `direct`: en el propio daemon. Sin valor, lo decide el daemon según la plataforma. */
  ptyMode: 'host' | 'direct' | undefined
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  maxConnections: number
  authTimeoutMs: number
}

/** Valida las variables de entorno al arrancar; lanza `Error` con un mensaje legible. */
export function parseEnv(env: Readonly<Record<string, string | undefined>>): DaemonEnv {
  const r = EnvSchema.safeParse({
    NEXO_PORT: env.NEXO_PORT === '' ? undefined : env.NEXO_PORT,
    NEXO_DEV: env.NEXO_DEV,
    NEXO_STATE_DIR: env.NEXO_STATE_DIR === '' ? undefined : env.NEXO_STATE_DIR,
    NEXO_PTY_MODE: env.NEXO_PTY_MODE === '' ? undefined : env.NEXO_PTY_MODE,
    NEXO_LOG_LEVEL: env.NEXO_LOG_LEVEL,
    NEXO_MAX_CONNECTIONS: env.NEXO_MAX_CONNECTIONS,
    NEXO_AUTH_TIMEOUT_MS: env.NEXO_AUTH_TIMEOUT_MS,
  })
  if (!r.success) {
    const issue = r.error.issues[0]
    const name = issue?.path.join('.') ?? 'entorno'
    throw new Error(`variable de entorno inválida ${name}: ${issue?.message ?? 'valor no válido'}`)
  }
  const d = r.data
  return {
    port: d.NEXO_PORT,
    dev: d.NEXO_DEV,
    stateDir: d.NEXO_STATE_DIR,
    ptyMode: d.NEXO_PTY_MODE,
    logLevel: d.NEXO_LOG_LEVEL,
    maxConnections: d.NEXO_MAX_CONNECTIONS,
    authTimeoutMs: d.NEXO_AUTH_TIMEOUT_MS,
  }
}
