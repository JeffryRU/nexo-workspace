import { type AcpAgentConfig, effectiveAcpAgents, parseAcpAgents } from '@nexo/adapter-provider-acp'
import { DEFAULT_OLLAMA_URL, parseOllamaUrl } from '@nexo/adapter-provider-ollama'
import { Token } from '@nexo/contracts'
import { z } from 'zod'

const bool = z
  .enum(['0', '1', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true')

/** Proveedores incluidos; además valen `gemini` y los ids declarados en `NEXO_ACP_AGENTS`. */
export const BUILTIN_PROVIDER_IDS = ['claude', 'codex', 'antigravity', 'ollama', 'fake'] as const
/** Id de un proveedor registrable (un incluido o un agente ACP). */
export type AgentProviderName = string

const acpAgentsEnv = z.string().transform((v, ctx) => {
  try {
    return parseAcpAgents(v)
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `NEXO_ACP_AGENTS inválido (${error instanceof Error ? error.message : 'no válido'})`,
    })
    return z.NEVER
  }
})

/** Lista de `NEXO_AGENT_PROVIDERS`: sin repetidos y solo ids conocidos (`known`). */
function providerList(known: readonly string[]) {
  return z
    .string()
    .transform((v) => v.split(',').map((p) => p.trim()))
    .pipe(
      z
        .array(
          z.string().refine((id) => known.includes(id), {
            error: `proveedor desconocido (valen: ${known.join(', ')})`,
          }),
        )
        .min(1)
        .max(known.length),
    )
    .refine((list) => new Set(list).size === list.length, 'proveedor repetido')
}

const ollamaUrl = z
  .string()
  .max(2048)
  .transform((v, ctx) => {
    try {
      return parseOllamaUrl(v)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `URL de Ollama inválida (${error instanceof Error ? error.message : 'no válida'})`,
      })
      return z.NEVER
    }
  })

/** Resumidor de la memoria elegido con `NEXO_MEMORY_SUMMARIZER`. */
export type MemorySummarizerSpec =
  | { kind: 'ollama'; model: string }
  | { kind: 'provider'; id: string; model?: string }
  /** Determinista, solo para pruebas (como el proveedor `fake`). */
  | { kind: 'fake' }

const SUMMARIZER_HELP = 'valen ollama:<modelo>, provider:<id>[:<modelo>] y fake'

/** `ollama:<modelo>` o `provider:<id>[:<modelo>]`; el modelo puede llevar `:` (`llama3.2:3b`). */
export function parseMemorySummarizer(value: string): MemorySummarizerSpec {
  if (value === 'fake') return { kind: 'fake' }
  const ollama = /^ollama:(.+)$/s.exec(value)
  if (ollama !== null) {
    const model = Token.safeParse(ollama[1])
    if (!model.success) throw new Error('modelo de Ollama no válido')
    return { kind: 'ollama', model: model.data }
  }
  const provider = /^provider:([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?::(.+))?$/s.exec(value)
  if (provider !== null) {
    const id = provider[1] as string
    if (provider[2] === undefined) return { kind: 'provider', id }
    const model = Token.safeParse(provider[2])
    if (!model.success) throw new Error('modelo del proveedor no válido')
    return { kind: 'provider', id, model: model.data }
  }
  throw new Error(SUMMARIZER_HELP)
}

const memoryFlag = z
  .enum(['on', 'off', '1', '0', 'true', 'false', ''])
  .optional()
  .transform((v) => v === 'on' || v === '1' || v === 'true')

const memorySummarizer = z
  .string()
  .max(256)
  .transform((v, ctx) => {
    try {
      return parseMemorySummarizer(v)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `NEXO_MEMORY_SUMMARIZER inválido (${error instanceof Error ? error.message : 'no válido'})`,
      })
      return z.NEVER
    }
  })

const EnvSchema = z.object({
  NEXO_PORT: z.coerce.number().int().min(0).max(65535).default(4317),
  NEXO_DEV: bool,
  NEXO_STATE_DIR: z.string().min(1).optional(),
  NEXO_PTY_MODE: z.enum(['host', 'direct']).optional(),
  NEXO_AGENT_PROVIDERS: z.string().optional(),
  NEXO_ACP_AGENTS: acpAgentsEnv.optional(),
  NEXO_CLAUDE_EXECUTABLE: z.string().min(1).max(4096).optional(),
  NEXO_CODEX_EXECUTABLE: z.string().min(1).max(4096).optional(),
  NEXO_AGY_EXECUTABLE: z.string().min(1).max(4096).optional(),
  NEXO_OLLAMA_URL: ollamaUrl.default(DEFAULT_OLLAMA_URL),
  NEXO_MEMORY: memoryFlag,
  NEXO_MEMORY_SUMMARIZER: memorySummarizer.optional(),
  NEXO_MEMORY_OBSERVER_TOKENS: z.coerce.number().int().min(500).max(200_000).optional(),
  NEXO_MEMORY_REFLECTOR_TOKENS: z.coerce.number().int().min(1000).max(2_000_000).optional(),
  NEXO_MEMORY_RENEW_TOKENS: z.coerce.number().int().min(10_000).max(5_000_000).optional(),
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
  /** Ruta del ejecutable de Codex (`codex`); por omisión se busca en el PATH. */
  codexExecutable: string | undefined
  /** Ruta del ejecutable de Antigravity (`agy`); por omisión se busca en el PATH. */
  agyExecutable: string | undefined
  /** Agentes ACP efectivos: `gemini` por omisión más los declarados en `NEXO_ACP_AGENTS`. */
  acpAgents: AcpAgentConfig[]
  /** URL base de la API de Ollama (`http://127.0.0.1:11434` por omisión). */
  ollamaUrl: string
  /** Memoria observacional (F3.5.2); apagada por omisión. */
  memory: {
    enabled: boolean
    summarizer: MemorySummarizerSpec | undefined
    /** Tokens nuevos de una sesión que disparan al Observador (6000 por omisión). */
    observerTokens: number | undefined
    /** Tokens de observaciones de un proyecto que disparan al Reflector (40000 por omisión). */
    reflectorTokens: number | undefined
    /** Renovación de sesión (F3.5.3): contexto estimado, en tokens, a partir del cual se reabre sembrada. Apagada sin valor. */
    renewTokens: number | undefined
  }
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
    NEXO_CODEX_EXECUTABLE: env.NEXO_CODEX_EXECUTABLE === '' ? undefined : env.NEXO_CODEX_EXECUTABLE,
    NEXO_AGY_EXECUTABLE: env.NEXO_AGY_EXECUTABLE === '' ? undefined : env.NEXO_AGY_EXECUTABLE,
    NEXO_ACP_AGENTS: env.NEXO_ACP_AGENTS === '' ? undefined : env.NEXO_ACP_AGENTS,
    NEXO_OLLAMA_URL: env.NEXO_OLLAMA_URL === '' ? undefined : env.NEXO_OLLAMA_URL,
    NEXO_MEMORY: env.NEXO_MEMORY,
    NEXO_MEMORY_SUMMARIZER:
      env.NEXO_MEMORY_SUMMARIZER === '' ? undefined : env.NEXO_MEMORY_SUMMARIZER,
    NEXO_MEMORY_OBSERVER_TOKENS:
      env.NEXO_MEMORY_OBSERVER_TOKENS === '' ? undefined : env.NEXO_MEMORY_OBSERVER_TOKENS,
    NEXO_MEMORY_REFLECTOR_TOKENS:
      env.NEXO_MEMORY_REFLECTOR_TOKENS === '' ? undefined : env.NEXO_MEMORY_REFLECTOR_TOKENS,
    NEXO_MEMORY_RENEW_TOKENS:
      env.NEXO_MEMORY_RENEW_TOKENS === '' ? undefined : env.NEXO_MEMORY_RENEW_TOKENS,
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
  const observerTokens = d.NEXO_MEMORY_OBSERVER_TOKENS
  const reflectorTokens = d.NEXO_MEMORY_REFLECTOR_TOKENS
  if (reflectorTokens !== undefined && reflectorTokens < (observerTokens ?? 6000) * 2) {
    throw new Error(
      `variable de entorno inválida NEXO_MEMORY_REFLECTOR_TOKENS: debe ser al menos el doble de NEXO_MEMORY_OBSERVER_TOKENS (${(observerTokens ?? 6000) * 2})`,
    )
  }
  const acpAgents = effectiveAcpAgents(d.NEXO_ACP_AGENTS ?? [])
  const known = [...BUILTIN_PROVIDER_IDS, ...acpAgents.map((a) => a.id)]
  let agentProviders: AgentProviderName[] = ['claude']
  if (d.NEXO_AGENT_PROVIDERS !== undefined) {
    const list = providerList(known).safeParse(d.NEXO_AGENT_PROVIDERS)
    if (!list.success) {
      throw new Error(
        `variable de entorno inválida NEXO_AGENT_PROVIDERS: ${list.error.issues[0]?.message ?? 'valor no válido'}`,
      )
    }
    agentProviders = list.data
  }
  return {
    port: d.NEXO_PORT,
    dev: d.NEXO_DEV,
    stateDir: d.NEXO_STATE_DIR,
    ptyMode: d.NEXO_PTY_MODE,
    agentProviders,
    acpAgents,
    claudeExecutable: d.NEXO_CLAUDE_EXECUTABLE,
    codexExecutable: d.NEXO_CODEX_EXECUTABLE,
    agyExecutable: d.NEXO_AGY_EXECUTABLE,
    ollamaUrl: d.NEXO_OLLAMA_URL,
    memory: {
      enabled: d.NEXO_MEMORY,
      summarizer: d.NEXO_MEMORY_SUMMARIZER,
      observerTokens,
      reflectorTokens,
      renewTokens: d.NEXO_MEMORY_RENEW_TOKENS,
    },
    logLevel: d.NEXO_LOG_LEVEL,
    maxConnections: d.NEXO_MAX_CONNECTIONS,
    authTimeoutMs: d.NEXO_AUTH_TIMEOUT_MS,
  }
}
