import { z } from 'zod'
import { AgentSessionId, Attention, BlockId, PaneId } from './domain.ts'
import { LIMITS } from './limits.ts'
import { bodyText, lineText } from './text.ts'

/**
 * Modelo normalizado de agentes (F2.1). Nada aquí es específico de Claude: lo que un proveedor emita se
 * traduce a estos bloques (ver `docs/ARCHITECTURE.md`, «Agentes»). Proveedor, modelo, esfuerzo y ficha de
 * sesión son cadenas abiertas (con forma acotada) para que un proveedor nuevo no cambie el contrato; las
 * capacidades que declara cada proveedor dicen qué valores acepta.
 */

/** Identificador de proveedor: `claude`, `codex`, `gemini`, `antigravity`, `ollama`... */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)
export type ProviderId = z.infer<typeof ProviderId>

/** Valor opaco corto (modelo, esfuerzo): sin espacios ni control; admite `llama3.2:3b`, `claude-opus-4-7[1m]`. */
export const Token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]*$/)
export type Token = z.infer<typeof Token>

/** Id de la sesión del proveedor (para reanudar). Opaco; nunca se interpreta. */
export const ProviderSessionToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/)
export type ProviderSessionToken = z.infer<typeof ProviderSessionToken>

/** Id local de una opción de permiso o de una pregunta. */
export const LocalId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/)
export type LocalId = z.infer<typeof LocalId>

/**
 * Modo de permisos normalizado. Cada adaptador lo traduce: Claude `default`/`acceptEdits`/`plan`/
 * `bypassPermissions`; Codex y ACP, sus modos de aprobación o de sesión.
 */
export const PermissionMode = z.enum(['ask', 'accept-edits', 'plan', 'bypass'])
export type PermissionMode = z.infer<typeof PermissionMode>

const Millis = z.int().nonnegative()

export const AgentSession = z.strictObject({
  id: AgentSessionId,
  provider: ProviderId,
  /** Ficha del proveedor para reanudar (la conoce tras abrir). */
  providerSessionId: ProviderSessionToken.optional(),
  paneId: PaneId,
  title: lineText(LIMITS.maxTitleLength).optional(),
  model: Token.optional(),
  effort: Token.optional(),
  permissionMode: PermissionMode,
  cwd: z.string().min(1).max(LIMITS.maxPathLength),
  status: Attention,
  /** Turno en curso o el último (0 = ninguno aún). */
  turn: z.int().nonnegative(),
  blockCount: z.int().nonnegative().max(LIMITS.maxBlocksPerSession),
  createdAt: Millis,
  updatedAt: Millis,
})
export type AgentSession = z.infer<typeof AgentSession>

// ---- Capacidades por proveedor (para armar los chips de la interfaz) ----

export const ModelInfo = z.strictObject({
  id: Token,
  label: lineText(LIMITS.maxTitleLength).optional(),
  /** Esfuerzos válidos para este modelo; sin él, valen los del proveedor. */
  efforts: z.array(Token).max(8).optional(),
})
export type ModelInfo = z.infer<typeof ModelInfo>

export const ProviderCapabilities = z.strictObject({
  models: z.array(ModelInfo).max(LIMITS.maxProviderModels),
  defaultModel: Token.optional(),
  efforts: z.array(Token).max(8),
  permissionModes: z.array(PermissionMode).min(1).max(4),
  /** Puede reanudar una sesión con su `providerSessionId`. */
  resume: z.boolean(),
  /** Puede precalentar el proceso antes del primer mensaje. */
  warmup: z.boolean(),
  /** Emite texto por deltas (si no, llega el bloque completo). */
  streaming: z.boolean(),
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

export const ProviderInfo = z.strictObject({
  id: ProviderId,
  name: lineText(LIMITS.maxTitleLength),
  available: z.boolean(),
  capabilities: ProviderCapabilities,
})
export type ProviderInfo = z.infer<typeof ProviderInfo>

// ---- Bloques ----

export const ActionKind = z.enum(['read', 'edit', 'exec', 'search', 'other'])
export type ActionKind = z.infer<typeof ActionKind>
export const ActionStatus = z.enum(['pending', 'running', 'ok', 'error'])
export type ActionStatus = z.infer<typeof ActionStatus>
export const PermissionState = z.enum(['pending', 'accepted', 'rejected', 'cancelled'])
export type PermissionState = z.infer<typeof PermissionState>
export const PermissionOptionKind = z.enum([
  'allow-once',
  'allow-always',
  'reject-once',
  'reject-always',
])
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>
export const QuestionState = z.enum(['pending', 'answered', 'cancelled'])
export type QuestionState = z.infer<typeof QuestionState>
export const PlanEntryStatus = z.enum(['pending', 'in-progress', 'completed'])
export type PlanEntryStatus = z.infer<typeof PlanEntryStatus>
export const StopReason = z.enum([
  'end-turn',
  'max-tokens',
  'max-turns',
  'refusal',
  'interrupted',
  'error',
  'other',
])
export type StopReason = z.infer<typeof StopReason>

export const PermissionOption = z.strictObject({
  id: LocalId,
  label: lineText(LIMITS.maxTitleLength),
  kind: PermissionOptionKind,
})
export type PermissionOption = z.infer<typeof PermissionOption>
export const PermissionOptions = z.array(PermissionOption).min(1).max(LIMITS.maxBlockOptions)

export const QuestionOption = z.strictObject({
  label: lineText(LIMITS.maxTitleLength),
  description: lineText(1024).optional(),
})
export const Question = z.strictObject({
  id: LocalId,
  header: lineText(64).optional(),
  question: bodyText(4096, 1),
  options: z.array(QuestionOption).max(LIMITS.maxBlockOptions),
  multiSelect: z.boolean(),
  /** Admite respuesta libre además de (o en vez de) las opciones. */
  allowText: z.boolean(),
})
export type Question = z.infer<typeof Question>
export const Questions = z.array(Question).min(1).max(LIMITS.maxQuestions)

export const QuestionAnswer = z.strictObject({
  questionId: LocalId,
  /** Etiquetas de las opciones elegidas. */
  selected: z.array(lineText(LIMITS.maxTitleLength)).max(LIMITS.maxBlockOptions),
  text: bodyText(8 * 1024, 1).optional(),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>
export const QuestionAnswers = z.array(QuestionAnswer).min(1).max(LIMITS.maxQuestions)

export const PlanEntry = z.strictObject({
  text: lineText(512),
  status: PlanEntryStatus,
})

/** Métricas de un turno; todas opcionales porque cada proveedor informa lo suyo. */
export const TurnUsage = z.strictObject({
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
  cacheReadTokens: z.int().nonnegative().optional(),
  cacheWriteTokens: z.int().nonnegative().optional(),
  reasoningTokens: z.int().nonnegative().optional(),
  costUsd: z.number().nonnegative().max(1e9).optional(),
  durationMs: z.int().nonnegative().optional(),
  /** Vueltas internas del proveedor (llamadas al modelo). */
  numTurns: z.int().nonnegative().optional(),
})
export type TurnUsage = z.infer<typeof TurnUsage>

export const ActionDiff = z.strictObject({
  path: lineText(LIMITS.maxPathLength),
  /** Diff unificado. */
  patch: bodyText(LIMITS.maxBlockTextBytes),
})

/** Campos de cada tipo de bloque (sin los comunes); el discriminante es `type`. */
const TextShape = {
  type: z.literal('text'),
  /** Markdown del agente. */
  text: bodyText(LIMITS.maxBlockTextBytes),
  complete: z.boolean(),
  truncated: z.boolean().optional(),
}
const UserShape = { type: z.literal('user'), text: bodyText(LIMITS.maxBlockTextBytes, 1) }
const ReasoningShape = {
  type: z.literal('reasoning'),
  text: bodyText(LIMITS.maxBlockTextBytes),
  complete: z.boolean(),
  truncated: z.boolean().optional(),
}
const ActionShape = {
  type: z.literal('action'),
  kind: ActionKind,
  status: ActionStatus,
  /** Nombre de la herramienta según el proveedor (`Read`, `Bash`, `mcp__x__y`...). */
  tool: lineText(128),
  /** Resumen de una línea para el encabezado plegable. */
  title: lineText(LIMITS.maxTitleLength),
  /** Id de la llamada en el proveedor, para correlacionar resultados. */
  callId: lineText(128).optional(),
  path: lineText(LIMITS.maxPathLength).optional(),
  input: bodyText(LIMITS.maxBlockInputBytes).optional(),
  output: bodyText(LIMITS.maxBlockTextBytes).optional(),
  diff: ActionDiff.optional(),
  exitCode: z.int().nullable().optional(),
  durationMs: z.int().nonnegative().optional(),
  truncated: z.boolean().optional(),
}
const PermissionShape = {
  type: z.literal('permission'),
  tool: lineText(128),
  title: lineText(LIMITS.maxTitleLength),
  detail: bodyText(LIMITS.maxBlockInputBytes).optional(),
  options: PermissionOptions,
  state: PermissionState,
  selectedOptionId: LocalId.optional(),
}
const QuestionShape = {
  type: z.literal('question'),
  questions: Questions,
  state: QuestionState,
  answers: QuestionAnswers.optional(),
}
const PlanShape = {
  type: z.literal('plan'),
  entries: z.array(PlanEntry).max(LIMITS.maxPlanEntries),
  markdown: bodyText(LIMITS.maxBlockTextBytes).optional(),
}
const ErrorShape = {
  type: z.literal('error'),
  code: lineText(64),
  message: bodyText(8 * 1024, 1),
  /** El proveedor no puede seguir (la sesión queda en `error`). */
  fatal: z.boolean(),
  retryable: z.boolean().optional(),
}
const UsageShape = {
  type: z.literal('usage'),
  stopReason: StopReason,
  usage: TurnUsage,
}

/** Campos comunes: identidad estable y orden para citar rangos de bloques. */
const BaseShape = {
  id: BlockId,
  /** Posición en el documento, 0, 1, 2... sin huecos, estable. Un rango `[a, b]` se puede citar. */
  index: z
    .int()
    .nonnegative()
    .max(LIMITS.maxBlocksPerSession - 1),
  turn: z.int().nonnegative(),
  /** Deltas ya aplicados a este bloque (ver `agent.delta`). */
  seq: z.int().nonnegative(),
  createdAt: Millis,
}

type Checkable =
  | {
      type: 'permission'
      options: PermissionOption[]
      state: PermissionState
      selectedOptionId?: string | undefined
    }
  | {
      type: 'question'
      questions: Question[]
      state: QuestionState
      answers?: QuestionAnswer[] | undefined
    }
  | { type: 'action'; kind: ActionKind; diff?: unknown; exitCode?: number | null | undefined }
  | { type: 'other' }

/** Reglas entre campos que zod no expresa por separado. Devuelve los problemas (vacío = válido). */
export function blockIssues(block: { type: string }): string[] {
  const b = block as Checkable
  const issues: string[] = []
  if (b.type === 'permission') {
    const ids = new Set(b.options.map((o) => o.id))
    if (ids.size !== b.options.length) issues.push('opciones con id repetido')
    const chosen = b.options.find((o) => o.id === b.selectedOptionId)
    if (b.selectedOptionId !== undefined && chosen === undefined) {
      issues.push('selectedOptionId no es una opción')
    }
    if (b.state === 'pending' && b.selectedOptionId !== undefined) {
      issues.push('un permiso pendiente no tiene opción elegida')
    }
    if (chosen !== undefined && b.state === 'accepted' && !chosen.kind.startsWith('allow')) {
      issues.push('aceptado con una opción de rechazo')
    }
    if (chosen !== undefined && b.state === 'rejected' && !chosen.kind.startsWith('reject')) {
      issues.push('rechazado con una opción de aceptación')
    }
  } else if (b.type === 'question') {
    const ids = new Set(b.questions.map((q) => q.id))
    if (ids.size !== b.questions.length) issues.push('preguntas con id repetido')
    if (b.state === 'answered' && b.answers === undefined) issues.push('respondida sin respuestas')
    if (b.state !== 'answered' && b.answers !== undefined)
      issues.push('respuestas sin estado answered')
  } else if (b.type === 'action') {
    if (b.diff !== undefined && b.kind !== 'edit') issues.push('solo una acción edit lleva diff')
    if (b.exitCode !== undefined && b.kind !== 'exec')
      issues.push('solo una acción exec lleva exitCode')
  }
  return issues
}

function withIssues<T extends z.ZodType<{ type: string }>>(schema: T) {
  return schema.superRefine((b, ctx) => {
    for (const message of blockIssues(b)) ctx.addIssue({ code: 'custom', message })
  })
}

const variants = <B extends z.ZodRawShape>(base: B) =>
  [
    z.strictObject({ ...base, ...UserShape }),
    z.strictObject({ ...base, ...TextShape }),
    z.strictObject({ ...base, ...ReasoningShape }),
    z.strictObject({ ...base, ...ActionShape }),
    z.strictObject({ ...base, ...PermissionShape }),
    z.strictObject({ ...base, ...QuestionShape }),
    z.strictObject({ ...base, ...PlanShape }),
    z.strictObject({ ...base, ...ErrorShape }),
    z.strictObject({ ...base, ...UsageShape }),
  ] as const

/** Un bloque del documento de una sesión. Unión discriminada por `type`. */
export const Block = withIssues(z.discriminatedUnion('type', variants(BaseShape)))
export type Block = z.infer<typeof Block>

/** Contenido de un bloque sin identidad ni orden: lo que emite un proveedor; el daemon pone el resto. */
export const BlockDraft = withIssues(z.discriminatedUnion('type', variants({})))
export type BlockDraft = z.infer<typeof BlockDraft>
export type BlockType = Block['type']
export const BLOCK_TYPES = [
  'user',
  'text',
  'reasoning',
  'action',
  'permission',
  'question',
  'plan',
  'error',
  'usage',
] as const satisfies readonly BlockType[]

// ---- Métodos y eventos (los registra methods.ts / events.ts) ----

export const AgentDelta = z.strictObject({
  sessionId: AgentSessionId,
  blockId: BlockId,
  /** Campo del bloque al que se añade: `text` (text, reasoning) o `output` (action). */
  field: z.enum(['text', 'output']),
  /** Número de delta de ese bloque: el primero tras el alta es `block.seq + 1`. */
  seq: z.int().positive(),
  text: bodyText(LIMITS.maxDeltaBytes, 1),
})
export type AgentDelta = z.infer<typeof AgentDelta>

export const AgentRespondParams = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('permission'),
    sessionId: AgentSessionId,
    blockId: BlockId,
    optionId: LocalId,
  }),
  z.strictObject({
    type: z.literal('question'),
    sessionId: AgentSessionId,
    blockId: BlockId,
    answers: QuestionAnswers,
  }),
])
export type AgentRespondParams = z.infer<typeof AgentRespondParams>
