import { z } from 'zod'

/**
 * Forma mínima de los mensajes del SDK que usa el adaptador (`SDKMessage` de `@anthropic-ai/claude-agent-sdk`).
 * Son laxos a propósito (`looseObject`): el SDK añade campos con frecuencia y un campo nuevo nunca debe romper
 * la traducción; solo se exige lo que se lee. Lo que no encaja se descarta y se cuenta.
 */
const Parent = z.string().nullable().optional()

export const StreamEnvelope = z.looseObject({
  type: z.literal('stream_event'),
  parent_tool_use_id: Parent,
  event: z.looseObject({ type: z.string() }),
})

export const MessageStart = z.looseObject({
  type: z.literal('message_start'),
  message: z.looseObject({ id: z.string().optional() }).optional(),
})

export const BlockStart = z.looseObject({
  type: z.literal('content_block_start'),
  index: z.int().nonnegative(),
  content_block: z.looseObject({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    text: z.string().optional(),
    thinking: z.string().optional(),
  }),
})

export const BlockDelta = z.looseObject({
  type: z.literal('content_block_delta'),
  index: z.int().nonnegative(),
  delta: z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    thinking: z.string().optional(),
    partial_json: z.string().optional(),
  }),
})

export const BlockStop = z.looseObject({
  type: z.literal('content_block_stop'),
  index: z.int().nonnegative(),
})

export const AssistantMessage = z.looseObject({
  type: z.literal('assistant'),
  parent_tool_use_id: Parent,
  error: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    content: z.array(z.unknown()),
  }),
})

export const ContentBlock = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
})

export const UserMessage = z.looseObject({
  type: z.literal('user'),
  parent_tool_use_id: Parent,
  message: z.looseObject({ content: z.unknown() }),
})

export const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
})

const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
})

export const ResultMessage = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  stop_reason: z.string().nullable().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  usage: Usage.optional(),
})

export const SystemMessage = z.looseObject({
  type: z.literal('system'),
  subtype: z.string(),
  session_id: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
})

export const AuthStatusMessage = z.looseObject({
  type: z.literal('auth_status'),
  error: z.string().optional(),
})

export const TodoWriteInput = z.looseObject({
  todos: z.array(
    z.looseObject({
      content: z.string(),
      status: z.string(),
      activeForm: z.string().optional(),
    }),
  ),
})
