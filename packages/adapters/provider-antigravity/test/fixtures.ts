/** Eventos de `agy --output-format stream-json` tal como los documenta la CLI (ver ARCHITECTURE). */
export const CONV = '11111111-2222-3333-4444-555555555555'

export const init = (extra: Record<string, unknown> = {}, id: string | undefined = CONV) => ({
  event: 'init',
  ...(id === undefined ? {} : { conversation_id: id }),
  init: { cwd: '/w', tools: ['run_command'], permission_mode: 'request-review', ...extra },
})

export const step = (
  index: number,
  state: 'ACTIVE' | 'DONE',
  type: string,
  extra: Record<string, unknown> = {},
) => ({
  event: 'step_update',
  step_update: { conversation_id: CONV, step_index: index, state, step_type: type, ...extra },
})

export const usage = {
  input_tokens: 100,
  output_tokens: 20,
  thinking_tokens: 5,
  cache_read_tokens: 60,
  total_tokens: 120,
}

export const result = (
  status: string,
  response: unknown = '',
  extra: Record<string, unknown> = {},
) => ({
  event: 'result',
  result: {
    conversation_id: CONV,
    status,
    response,
    duration_seconds: 1.5,
    num_turns: 1,
    usage,
    ...extra,
  },
})

export const tool = (
  index: number,
  state: 'ACTIVE' | 'DONE',
  name: string,
  parameters: unknown,
  extra: Record<string, unknown> = {},
) =>
  step(index, state, 'tool', {
    tool_name: name,
    tool_info: { name, parameters, ...extra },
  })
