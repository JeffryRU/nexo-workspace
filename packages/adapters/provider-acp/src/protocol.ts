import { z } from 'zod'

/**
 * Agent Client Protocol (ACP), versión **1** (estable). El protocolo no sale de memoria: sale del esquema JSON
 * publicado en `@agentclientprotocol/sdk@2.12.0` (`schema/v1/schema.json` y `schema.unstable.json`), que
 * documenta https://agentclientprotocol.com. Este archivo guarda solo los esquemas zod propios del subconjunto
 * que Nexo usa, en modo laxo (`looseObject`: un campo nuevo no rompe; lo que no encaja se ignora y se cuenta).
 * Al subir la versión del esquema hay que revisarlo. Nexo no depende del SDK (5 MB, con transportes HTTP,
 * WebSocket y MCP que aquí no se usan).
 */
export const ACP_PROTOCOL_VERSION = 1
export const ACP_SCHEMA_SOURCE = '@agentclientprotocol/sdk@2.12.0 (schema/v1)'

/** Códigos de error ACP además de los de JSON-RPC (esquema `ErrorCode`). */
export const AcpErrorCodes = {
  authRequired: -32000,
  resourceNotFound: -32002,
  requestCancelled: -32800,
} as const

const Id = z.string().min(1).max(1024)

/** Valida cada elemento por separado y se queda con los válidos (como `x-deserialize-skip-invalid-items`). */
function validItems<S extends z.ZodType>(raw: unknown, schema: S, max: number): z.infer<S>[] {
  if (!Array.isArray(raw)) return []
  const out: z.infer<S>[] = []
  for (const item of raw.slice(0, max)) {
    const r = schema.safeParse(item)
    if (r.success) out.push(r.data)
  }
  return out
}

// ---- handshake ----

export const InitializeResult = z.looseObject({
  protocolVersion: z.number().int().min(0).max(65535),
  agentCapabilities: z
    .looseObject({
      loadSession: z.boolean().optional(),
      /** Capacidades de sesión del esquema estable de ACP; `list` (objeto vacío) anuncia `session/list`. */
      sessionCapabilities: z.looseObject({ list: z.unknown().optional() }).nullish(),
    })
    .nullish(),
  authMethods: z.array(z.unknown()).nullish(),
})
export type InitializeResult = z.infer<typeof InitializeResult>

const AuthMethod = z.looseObject({ id: Id, name: z.string().max(512).optional() })

/** Nombres (o ids) de los métodos de autenticación que anuncia el agente. */
export function authMethodNames(result: InitializeResult): string[] {
  return validItems(result.authMethods, AuthMethod, 16).map((m) => m.name ?? m.id)
}

const Mode = z.looseObject({ id: Id, name: z.string().max(512).optional() })
const ModeState = z.looseObject({ currentModeId: Id, availableModes: z.array(z.unknown()) })

/** `models` es del esquema inestable (`session/set_model`); algunos agentes (Gemini) lo anuncian. */
const ModelState = z.looseObject({ currentModelId: Id, availableModels: z.array(z.unknown()) })
const Model = z.looseObject({ modelId: Id, name: z.string().max(512).optional() })

const ConfigValue = z.looseObject({ value: Id, name: z.string().max(512).optional() })
const ConfigGroup = z.looseObject({ group: Id, options: z.array(z.unknown()) })
const ConfigOption = z.looseObject({
  id: Id,
  type: z.string().max(32).optional(),
  category: z.string().max(64).nullish(),
  currentValue: z.unknown().optional(),
  options: z.array(z.unknown()).optional(),
})

export const NewSessionResult = z.looseObject({
  sessionId: Id,
  modes: z.unknown().optional(),
  models: z.unknown().optional(),
  configOptions: z.unknown().optional(),
})
export type NewSessionResult = z.infer<typeof NewSessionResult>

export const LoadSessionResult = z.looseObject({
  modes: z.unknown().optional(),
  models: z.unknown().optional(),
  configOptions: z.unknown().optional(),
})

export type NamedId = { id: string; name: string }
/** Lo que Nexo lee de las tres formas en que un agente anuncia modos, modelos y opciones de una sesión. */
export type SessionOptions = {
  modes: { current: string; available: NamedId[] } | undefined
  models: { current: string | undefined; available: NamedId[] } | undefined
  /** Opción de configuración de categoría `model` (el camino estable para elegir modelo). */
  modelConfig: { configId: string } | undefined
}

/** Modos, modelos y la opción de configuración de modelo de una respuesta de `session/new` o `session/load`. */
export function readSessionOptions(result: {
  modes?: unknown
  models?: unknown
  configOptions?: unknown
}): SessionOptions {
  const modes = ModeState.safeParse(result.modes)
  const models = ModelState.safeParse(result.models)
  let config: { configId: string; current: string | undefined; available: NamedId[] } | undefined
  for (const o of validItems(result.configOptions, ConfigOption, 64)) {
    if (o.category !== 'model' || o.type === 'boolean') continue
    const available: NamedId[] = []
    for (const entry of o.options ?? []) {
      const group = ConfigGroup.safeParse(entry)
      const values = group.success ? validItems(group.data.options, ConfigValue, 256) : []
      const one = ConfigValue.safeParse(entry)
      for (const v of group.success ? values : one.success ? [one.data] : []) {
        available.push({ id: v.value, name: v.name ?? v.value })
      }
    }
    config = {
      configId: o.id,
      current: typeof o.currentValue === 'string' ? o.currentValue : undefined,
      available,
    }
    break
  }
  return {
    modes: modes.success
      ? {
          current: modes.data.currentModeId,
          available: validItems(modes.data.availableModes, Mode, 64).map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
          })),
        }
      : undefined,
    models:
      config !== undefined
        ? { current: config.current, available: config.available }
        : models.success
          ? {
              current: models.data.currentModelId,
              available: validItems(models.data.availableModels, Model, 256).map((m) => ({
                id: m.modelId,
                name: m.name ?? m.modelId,
              })),
            }
          : undefined,
    modelConfig: config === undefined ? undefined : { configId: config.configId },
  }
}

// ---- turno ----

const Count = z.number().nullish()
export const PromptResult = z.looseObject({
  stopReason: z.string().max(64),
  /** Del esquema inestable. */
  usage: z
    .looseObject({
      inputTokens: Count,
      outputTokens: Count,
      thoughtTokens: Count,
      cachedReadTokens: Count,
      cachedWriteTokens: Count,
    })
    .nullish(),
})
export type PromptResult = z.infer<typeof PromptResult>

// ---- session/update ----

export const SessionNotification = z.looseObject({
  sessionId: Id,
  update: z.looseObject({ sessionUpdate: z.string().max(64) }),
})

export const ContentChunk = z.looseObject({
  content: z.looseObject({
    type: z.string().max(32),
    text: z.string().optional(),
    uri: z.string().max(8192).optional(),
    name: z.string().max(1024).optional(),
  }),
  messageId: z.string().max(256).nullish(),
})
export type ContentChunk = z.infer<typeof ContentChunk>

const PlanEntry = z.looseObject({
  content: z.string().max(64 * 1024),
  status: z.string().max(32).optional(),
})
export const Plan = z.looseObject({ entries: z.array(z.unknown()) })
export const PlanUpdate = z.looseObject({
  plan: z.looseObject({
    type: z.string().max(16),
    planId: z.string().max(256).optional(),
    entries: z.array(z.unknown()).optional(),
    content: z
      .string()
      .max(4 * 1024 * 1024)
      .optional(),
  }),
})
export const planEntries = (raw: unknown[]) => validItems(raw, PlanEntry, 1024)

export const ToolCallFields = z.looseObject({
  toolCallId: Id,
  title: z
    .string()
    .max(64 * 1024)
    .nullish(),
  name: z.string().max(256).nullish(),
  kind: z.string().max(32).nullish(),
  status: z.string().max(32).nullish(),
  content: z.array(z.unknown()).nullish(),
  locations: z.array(z.unknown()).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
})
export type ToolCallFields = z.infer<typeof ToolCallFields>

const DiffContent = z.looseObject({
  type: z.literal('diff'),
  path: z.string().min(1).max(8192),
  oldText: z.string().nullish(),
  newText: z.string(),
})
const TextToolContent = z.looseObject({
  type: z.literal('content'),
  content: z.looseObject({ type: z.string(), text: z.string().optional() }),
})
const Location = z.looseObject({ path: z.string().min(1).max(8192) })
export type DiffItem = z.infer<typeof DiffContent>

/** Diffs, textos y rutas de los `content` y `locations` de una llamada a herramienta. */
export function readToolContent(call: ToolCallFields): {
  diffs: DiffItem[]
  texts: string[]
  paths: string[]
} {
  const diffs: DiffItem[] = []
  const texts: string[] = []
  for (const item of (call.content ?? []).slice(0, 256)) {
    const d = DiffContent.safeParse(item)
    if (d.success) {
      diffs.push(d.data)
      continue
    }
    const t = TextToolContent.safeParse(item)
    if (t.success && t.data.content.type === 'text' && t.data.content.text !== undefined) {
      texts.push(t.data.content.text)
    }
  }
  const paths = validItems(call.locations, Location, 64).map((l) => l.path)
  return { diffs, texts, paths }
}

export const ModeUpdate = z.looseObject({ currentModeId: Id })
export const InfoUpdate = z.looseObject({ title: z.string().max(4096).nullish() })

// ---- permisos ----

const PermissionOption = z.looseObject({
  optionId: Id,
  name: z.string().max(1024),
  kind: z.string().max(32),
})
export type AcpPermissionOption = z.infer<typeof PermissionOption>
export const RequestPermissionParams = z.looseObject({
  sessionId: Id,
  toolCall: ToolCallFields,
  options: z.array(z.unknown()),
})
export const permissionOptions = (raw: unknown[]) => validItems(raw, PermissionOption, 64)

// ---- historial (`session/list`) ----

export const SessionSummary = z.looseObject({
  sessionId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/),
  cwd: z.string().max(4096),
  title: z.string().nullish(),
  updatedAt: z.string().nullish(),
})

export const SessionListResult = z.looseObject({
  sessions: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
})
