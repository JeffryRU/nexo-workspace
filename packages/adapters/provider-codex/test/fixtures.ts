/**
 * Notificaciones de `codex app-server` (codex-cli 0.158.0), escritas a partir del esquema que genera la CLI
 * (`codex app-server generate-ts`). Solo los campos que el adaptador lee más algunos de relleno.
 */
export const THREAD = 'th-1'
export const TURN = 'tu-1'

const ids = { threadId: THREAD, turnId: TURN }

export type Note = { method: string; params: unknown }
export const note = (method: string, params: unknown): Note => ({ method, params })

export const turnStarted = (id = TURN) =>
  note('turn/started', {
    threadId: THREAD,
    turn: { id, items: [], status: 'inProgress', error: null },
  })

export const turnCompleted = (
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress' = 'completed',
  extra: { error?: unknown; durationMs?: number | null; id?: string } = {},
) =>
  note('turn/completed', {
    threadId: THREAD,
    turn: {
      id: extra.id ?? TURN,
      items: [],
      status,
      error: extra.error ?? null,
      durationMs: extra.durationMs ?? null,
    },
  })

export const started = (item: Record<string, unknown>) =>
  note('item/started', { ...ids, item, startedAtMs: 1 })
export const completed = (item: Record<string, unknown>) =>
  note('item/completed', { ...ids, item, completedAtMs: 2 })

export const agentMessage = (id: string, text = '') => ({
  type: 'agentMessage',
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
})
export const reasoning = (id: string, summary: string[] = [], content: string[] = []) => ({
  type: 'reasoning',
  id,
  summary,
  content,
})
export const command = (
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: 'commandExecution',
  id,
  pluginId: null,
  scriptPath: null,
  command: 'ls -la',
  cwd: '/w',
  processId: null,
  source: 'agent',
  status: 'inProgress',
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...over,
})
export const fileChange = (id: string, over: Record<string, unknown> = {}) => ({
  type: 'fileChange',
  id,
  status: 'inProgress',
  changes: [
    { path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
  ],
  ...over,
})

export const delta = (method: string, itemId: string, text: string, extra = {}) =>
  note(method, { ...ids, itemId, delta: text, ...extra })
export const messageDelta = (itemId: string, text: string) =>
  delta('item/agentMessage/delta', itemId, text)
export const summaryDelta = (itemId: string, text: string, summaryIndex = 0) =>
  delta('item/reasoning/summaryTextDelta', itemId, text, { summaryIndex })
export const outputDelta = (itemId: string, text: string) =>
  delta('item/commandExecution/outputDelta', itemId, text)

const breakdown = (input: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 0,
})
export const tokenUsage = (total: [number, number], last: [number, number]): Note =>
  note('thread/tokenUsage/updated', {
    ...ids,
    tokenUsage: { total: breakdown(...total), last: breakdown(...last), modelContextWindow: null },
  })
