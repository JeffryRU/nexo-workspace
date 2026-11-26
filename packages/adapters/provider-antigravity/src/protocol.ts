import { z } from 'zod'

/**
 * Esquema (permisivo) de la salida `agy --output-format stream-json`, según la documentación oficial
 * (antigravity.google/docs/cli/headless) y las notas de versión de la CLI. Verificado con `agy` 1.5.17: banderas, `agy
 * models` y un turno real de texto con reanudación (prueba en vivo); el resto de eventos sale de la documentación (ver
 * `docs/ARCHITECTURE.md`, «Proveedor Antigravity (F3.4)»). Todo campo es opcional y los desconocidos se
 * ignoran: un cambio menor de la CLI no debe romper el adaptador.
 */
export const AGY_VERIFIED_VERSION = '1.5.17'

const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  thinking_tokens: z.number().optional(),
  cache_read_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
})
export type AgyUsage = z.infer<typeof Usage>

const ToolInfo = z.looseObject({
  name: z.string().optional(),
  parameters: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
})
export type AgyToolInfo = z.infer<typeof ToolInfo>

const SubagentInfo = z.looseObject({
  subagents: z
    .array(
      z.looseObject({
        type_name: z.string().optional(),
        role: z.string().optional(),
        conversation_id: z.string().optional(),
      }),
    )
    .optional(),
})
export type AgySubagentInfo = z.infer<typeof SubagentInfo>

export const StepUpdate = z.looseObject({
  conversation_id: z.string().optional(),
  step_index: z.number().int().nonnegative().optional(),
  state: z.string().optional(),
  step_type: z.string().optional(),
  tool_name: z.string().optional(),
  text_delta: z.string().optional(),
  duration_seconds: z.number().optional(),
  usage: Usage.optional(),
  tool_info: ToolInfo.optional(),
  subagent_info: SubagentInfo.optional(),
})
export type AgyStepUpdate = z.infer<typeof StepUpdate>

export const ResultPayload = z.looseObject({
  conversation_id: z.string().optional(),
  status: z.string().optional(),
  response: z.unknown().optional(),
  error: z.unknown().optional(),
  finished_reason: z.string().optional(),
  duration_seconds: z.number().optional(),
  num_turns: z.number().optional(),
  usage: Usage.optional(),
})
export type AgyResult = z.infer<typeof ResultPayload>

export const InitPayload = z.looseObject({
  cwd: z.string().optional(),
  tools: z.array(z.unknown()).optional(),
  permission_mode: z.string().optional(),
  model: z.string().optional(),
  agent: z.string().optional(),
})
export type AgyInit = z.infer<typeof InitPayload>

/** Un evento de la salida; `event` decide qué carga trae. */
export const AgyEvent = z.looseObject({
  event: z.string(),
  conversation_id: z.string().optional(),
  init: InitPayload.optional(),
  step_update: StepUpdate.optional(),
  result: ResultPayload.optional(),
})
export type AgyEvent = z.infer<typeof AgyEvent>

/** Mensaje de entrada (`--input-format stream-json`): una línea por mensaje de usuario. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: text } })}\n`
}
