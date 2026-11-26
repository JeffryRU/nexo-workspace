import { z } from 'zod'

/**
 * Subconjunto del protocolo de `codex app-server` que usa Nexo, escrito a mano a partir del esquema que
 * genera la propia CLI (`codex app-server generate-json-schema` / `generate-ts`). Versión fijada: la
 * CLI `codex-cli 0.158.0`. El protocolo es experimental y cambia entre versiones, así que todo lo que llega
 * se valida de forma laxa (`looseObject`): lo que no se reconoce se ignora, nunca rompe la sesión.
 *
 * Particularidades verificadas en 0.158.0: los mensajes no llevan `"jsonrpc":"2.0"`; las notificaciones
 * del servidor usan `method` en camelCase con `/` (`item/agentMessage/delta`); `initialize` va seguido de la
 * notificación `initialized`; los ids de hilo y de turno son UUID.
 */
export const CODEX_PROTOCOL_VERSION = '0.158.0'

const Text = z.string()
const OptText = z.string().nullish()

// ---- Respuestas a solicitudes del cliente ----

export const InitializeResult = z.looseObject({ userAgent: OptText })

export const ThreadResult = z.looseObject({
  thread: z.looseObject({ id: z.string().min(1) }),
  model: OptText,
  reasoningEffort: OptText,
})

export const TurnResult = z.looseObject({ turn: z.looseObject({ id: z.string().min(1) }) })

export const AccountResult = z.looseObject({
  account: z.unknown().optional(),
  requiresOpenaiAuth: z.boolean().optional(),
})

const ModelEntry = z.looseObject({
  id: Text,
  model: OptText,
  displayName: OptText,
  hidden: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: Text })).nullish(),
})
export const ModelListResult = z.looseObject({
  data: z.array(ModelEntry),
  nextCursor: OptText,
})
export type ModelEntry = z.infer<typeof ModelEntry>

// ---- Notificaciones del servidor ----

const Ids = { threadId: Text, turnId: Text, itemId: Text }

export const TurnNotification = z.looseObject({
  threadId: Text,
  turn: z.looseObject({
    id: Text,
    status: Text.optional(),
    durationMs: z.number().nullish(),
    error: z
      .looseObject({
        message: Text,
        codexErrorInfo: z.unknown().optional(),
        additionalDetails: OptText,
      })
      .nullish(),
  }),
})
export type TurnNotification = z.infer<typeof TurnNotification>

export const ItemNotification = z.looseObject({
  threadId: Text,
  turnId: Text,
  item: z.looseObject({ type: Text, id: Text }),
})

export const TextDelta = z.looseObject({ ...Ids, delta: Text })
export const SummaryDelta = z.looseObject({ ...Ids, delta: Text, summaryIndex: z.number() })

export const PatchUpdated = z.looseObject({ ...Ids, changes: z.array(z.unknown()) })

const Breakdown = z.looseObject({
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional(),
})
export type Breakdown = z.infer<typeof Breakdown>
export const TokenUsageNotification = z.looseObject({
  threadId: Text,
  turnId: Text,
  tokenUsage: z.looseObject({ total: Breakdown, last: Breakdown }),
})

export const ErrorNotification = z.looseObject({
  threadId: Text.optional(),
  turnId: Text.optional(),
  willRetry: z.boolean().optional(),
  error: z.looseObject({
    message: Text,
    codexErrorInfo: z.unknown().optional(),
    additionalDetails: OptText,
  }),
})

export const ResolvedNotification = z.looseObject({
  threadId: Text.optional(),
  requestId: z.union([z.string(), z.number()]),
})

// ---- Items ----

export const AgentMessageItem = z.looseObject({ text: Text })
export const ReasoningItem = z.looseObject({
  summary: z.array(Text).nullish(),
  content: z.array(Text).nullish(),
})
export const CommandItem = z.looseObject({
  command: Text,
  cwd: OptText,
  status: Text,
  aggregatedOutput: OptText,
  exitCode: z.number().nullish(),
  durationMs: z.number().nullish(),
})
export const FileChange = z.looseObject({
  path: Text,
  kind: z.looseObject({ type: Text }).optional(),
  diff: OptText,
})
export type FileChange = z.infer<typeof FileChange>
export const FileChangeItem = z.looseObject({
  changes: z.array(z.unknown()),
  status: Text,
})
export const McpItem = z.looseObject({
  server: Text,
  tool: Text,
  status: Text,
  arguments: z.unknown().optional(),
  result: z.looseObject({ content: z.array(z.unknown()).optional() }).nullish(),
  error: z.looseObject({ message: Text }).nullish(),
  durationMs: z.number().nullish(),
})
export const DynamicToolItem = z.looseObject({
  tool: Text,
  namespace: OptText,
  status: Text.optional(),
  arguments: z.unknown().optional(),
  success: z.boolean().nullish(),
  durationMs: z.number().nullish(),
})
export const WebSearchItem = z.looseObject({
  query: OptText,
  action: z
    .looseObject({
      type: Text,
      query: OptText,
      queries: z.array(Text).nullish(),
      url: OptText,
      pattern: OptText,
    })
    .nullish(),
})
export const PlanItem = z.looseObject({ text: Text })
export const ImageViewItem = z.looseObject({ path: Text })
export const CollabItem = z.looseObject({
  tool: Text,
  status: Text.optional(),
  prompt: OptText,
})

// ---- Solicitudes del servidor (aprobaciones) ----

export const CommandApprovalParams = z.looseObject({
  kind: Text.optional(),
  command: OptText,
  cwd: OptText,
  reason: OptText,
})
export const FileChangeApprovalParams = z.looseObject({
  reason: OptText,
  grantRoot: OptText,
})
export const PermissionsApprovalParams = z.looseObject({
  cwd: OptText,
  reason: OptText,
  permissions: z.looseObject({
    network: z.unknown().optional(),
    fileSystem: z.unknown().optional(),
  }),
})
