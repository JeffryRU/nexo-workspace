import { z } from 'zod'

/** Ids que ya usan otros proveedores: un agente ACP declarado no puede llamarse así. */
export const RESERVED_PROVIDER_IDS = ['claude', 'codex', 'antigravity', 'ollama', 'fake'] as const

function hasControl(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
const noNul = (s: string) => !s.includes(String.fromCharCode(0))

/** Un agente ACP: cada uno es un proveedor distinto (`id` = id del proveedor). */
export const AcpAgentConfig = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, 'id inválido (minúsculas, dígitos y guiones; máx. 32)')
    .refine((id) => !(RESERVED_PROVIDER_IDS as readonly string[]).includes(id), {
      error: `id reservado (${RESERVED_PROVIDER_IDS.join(', ')})`,
    }),
  name: z
    .string()
    .min(1)
    .max(64)
    .refine((s) => !hasControl(s), 'el nombre no admite caracteres de control'),
  command: z.string().min(1).max(4096).refine(noNul, 'comando inválido'),
  args: z.array(z.string().max(4096).refine(noNul, 'argumento inválido')).max(64).default([]),
  env: z
    .record(
      EnvName,
      z
        .string()
        .max(32 * 1024)
        .refine(noNul, 'valor inválido'),
    )
    .refine((env) => Object.keys(env).length <= 64, 'demasiadas variables (máx. 64)')
    .refine((env) => Object.keys(env).every((k) => !k.startsWith('NEXO_')), {
      error: 'las variables NEXO_* no se pasan a los agentes',
    })
    .optional(),
})
export type AcpAgentConfig = z.output<typeof AcpAgentConfig>

/** Máximo de agentes ACP declarados. */
export const MAX_ACP_AGENTS = 16

export const AcpAgentList = z
  .array(AcpAgentConfig)
  .max(MAX_ACP_AGENTS, `demasiados agentes (máx. ${MAX_ACP_AGENTS})`)
  .refine((list) => new Set(list.map((a) => a.id)).size === list.length, 'id de agente repetido')

/**
 * Agentes que existen sin configurar nada. Gemini CLI habla ACP con `--acp` (antes `--experimental-acp`, hoy
 * obsoleto). Declarar un agente con id `gemini` sustituye esta definición.
 */
export const DEFAULT_ACP_AGENTS: readonly AcpAgentConfig[] = [
  { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['--acp'] },
]

/** Tope de lo que se acepta en `NEXO_ACP_AGENTS`, para no analizar un JSON desmesurado. */
const MAX_JSON_CHARS = 256 * 1024

/**
 * Analiza `NEXO_ACP_AGENTS` (JSON: lista de `{ id, name, command, args?, env? }`). Lanza `Error` con un
 * mensaje legible. Devuelve los agentes declarados, sin los de omisión.
 */
export function parseAcpAgents(json: string): AcpAgentConfig[] {
  if (json.length > MAX_JSON_CHARS) throw new Error('JSON demasiado grande')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    throw new Error('no es JSON válido')
  }
  const result = AcpAgentList.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new Error(`${where}${issue?.message ?? 'valor no válido'}`)
  }
  return result.data
}

/** Agentes efectivos: los de omisión (salvo los que se redeclaran por id) más los declarados. */
export function effectiveAcpAgents(declared: readonly AcpAgentConfig[]): AcpAgentConfig[] {
  const ids = new Set(declared.map((a) => a.id))
  return [...DEFAULT_ACP_AGENTS.filter((a) => !ids.has(a.id)), ...declared]
}
