import { z } from 'zod'

const bool = z
  .enum(['0', '1', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true')

export const AGENT_PROVIDER_IDS = ['claude', 'fake'] as const
export type AgentProviderName = (typeof AGENT_PROVIDER_IDS)[number]

const providerList = z
  .string()
  .transform((v) => v.split(',').map((p) => p.trim()))
  .pipe(
    z
      .array(z.enum(AGENT_PROVIDER_IDS, { error: 'proveedor desconocido (valen: claude, fake)' }))
      .min(1)
      .max(AGENT_PROVIDER_IDS.length),
  )
  .refine((list) => new Set(list).size === list.length, 'proveedor repetido')

const EnvSchema = z.object({
  NEXO_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  NEXO_DEV: bool,
  NEXO_STATE_DIR: z.string().min(1).optional(),
  NEXO_PTY_MODE: z.enum(['host', 'direct']).optional(),
  NEXO_AGENT_PROVIDERS: providerList.optional(),
  NEXO_CLAUDE_EXECUTABLE: z.string().min(1).max(4096).optional(),
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
  /** Proveedores de agente registrados, en orden (el primero es el que se precalienta). Por omisión `claude`. */
  agentProviders: AgentProviderName[]
  /** Ruta del ejecutable de Claude Code; por omisión, el que trae el SDK. */
  claudeExecutable: string | undefined
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
    NEXO_AGENT_PROVIDERS: env.NEXO_AGENT_PROVIDERS === '' ? undefined : env.NEXO_AGENT_PROVIDERS,
    NEXO_CLAUDE_EXECUTABLE:
      env.NEXO_CLAUDE_EXECUTABLE === '' ? undefined : env.NEXO_CLAUDE_EXECUTABLE,
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
    agentProviders: d.NEXO_AGENT_PROVIDERS ?? ['claude'],
    claudeExecutable: d.NEXO_CLAUDE_EXECUTABLE,
    logLevel: d.NEXO_LOG_LEVEL,
    maxConnections: d.NEXO_MAX_CONNECTIONS,
    authTimeoutMs: d.NEXO_AUTH_TIMEOUT_MS,
  }
}
