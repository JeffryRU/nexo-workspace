import {
  type AgentDelta,
  AgentSession,
  AgentSessionId,
  type Block,
  type BlockDraft,
  BlockId,
  type MethodName,
  type MethodParams,
  PaneId,
  type ProviderCapabilities,
  type ProviderEvent,
  type Question,
  type QuestionAnswer,
  type TypedEvent,
  type TypedRequest,
} from '@nexo/contracts'
import * as fc from 'fast-check'

const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/)
const localId = fc.stringMatching(/^[A-Za-z0-9_.:-]{1,24}$/)
export const arbAgentSessionId = id.map((s) => AgentSessionId.parse(s))
export const arbBlockId = id.map((s) => BlockId.parse(s))

/** Texto de una línea válido (sin control ni sustitutos sueltos). */
export const arbLine = (max = 60): fc.Arbitrary<string> =>
  fc
    .stringMatching(/^[A-Za-z0-9áéíóúñ._:/-][A-Za-z0-9 áéíóúñ._:/-]{0,59}$/)
    .map((s) => s.slice(0, max))

const pieces = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.constantFrom(
    '\n',
    '\t',
    '\r\n',
    '\u001b[31mrojo\u001b[0m',
    '😀',
    '日本語',
    '# título\n',
    '```ts\nx\n```',
  ),
)

/** Texto de varias líneas válido: admite saltos, ANSI y astrales, nunca NUL ni sustitutos sueltos. */
export const arbBody = (minLength = 0): fc.Arbitrary<string> =>
  fc
    .array(pieces, { minLength: minLength > 0 ? 1 : 0, maxLength: 8 })
    .map((p) => p.join(''))
    .filter((s) => s.length >= minLength && !s.includes('\u0000'))

const arbToken = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,30}$/)
const arbMs = fc.integer({ min: 0, max: 2 ** 40 })
const arbCount = fc.integer({ min: 0, max: 1_000_000 })

export const arbTurnUsage = fc.record(
  {
    inputTokens: arbCount,
    outputTokens: arbCount,
    cacheReadTokens: arbCount,
    cacheWriteTokens: arbCount,
    reasoningTokens: arbCount,
    // Enteros / 1e6: los dobles con signo cero o notación rara no sobreviven siempre al round-trip.
    costUsd: fc.integer({ min: 0, max: 10_000_000 }).map((n) => n / 1e6),
    durationMs: arbCount,
    numTurns: fc.integer({ min: 0, max: 1000 }),
  },
  { requiredKeys: [] },
)

const arbPermissionOptions = fc
  .record({
    extra: fc.uniqueArray(
      fc.record({
        id: localId,
        label: arbLine(30),
        kind: fc.constantFrom(
          'allow-once',
          'allow-always',
          'reject-once',
          'reject-always' as const,
        ),
      }),
      { selector: (o) => o.id, maxLength: 4 },
    ),
  })
  .map(({ extra }) => {
    const base = [
      { id: 'allow', label: 'Permitir', kind: 'allow-once' as const },
      { id: 'deny', label: 'Rechazar', kind: 'reject-once' as const },
    ]
    return [...base, ...extra.filter((o) => o.id !== 'allow' && o.id !== 'deny')]
  })

const arbQuestion: fc.Arbitrary<Question> = fc
  .record(
    {
      id: localId,
      header: arbLine(12),
      question: arbBody(1).filter((s) => s.length <= 500),
      options: fc.array(
        fc.record({ label: arbLine(30), description: arbLine(60) }, { requiredKeys: ['label'] }),
        { maxLength: 4 },
      ),
      multiSelect: fc.boolean(),
      allowText: fc.boolean(),
    },
    { requiredKeys: ['id', 'question', 'options', 'multiSelect', 'allowText'] },
  )
  .map((q) => q as Question)

const arbQuestions = fc.uniqueArray(arbQuestion, {
  selector: (q) => q.id,
  minLength: 1,
  maxLength: 3,
})

export const arbQuestionAnswers: fc.Arbitrary<QuestionAnswer[]> = fc.array(
  fc.record(
    { questionId: localId, selected: fc.array(arbLine(30), { maxLength: 3 }), text: arbBody(1) },
    { requiredKeys: ['questionId', 'selected'] },
  ),
  { minLength: 1, maxLength: 3 },
) as fc.Arbitrary<QuestionAnswer[]>

const arbActionDraft: fc.Arbitrary<BlockDraft> = fc
  .record({
    kind: fc.constantFrom('read', 'edit', 'exec', 'search', 'other' as const),
    status: fc.constantFrom('pending', 'running', 'ok', 'error' as const),
    tool: arbToken,
    title: arbLine(),
    callId: fc.option(arbToken, { nil: undefined }),
    path: fc.option(arbLine(), { nil: undefined }),
    input: fc.option(arbBody(), { nil: undefined }),
    output: fc.option(arbBody(), { nil: undefined }),
    diff: fc.record({ path: arbLine(), patch: arbBody() }),
    exitCode: fc.option(fc.integer({ min: -255, max: 255 }), { nil: undefined }),
    durationMs: fc.option(arbCount, { nil: undefined }),
    truncated: fc.option(fc.boolean(), { nil: undefined }),
  })
  .map((r) => {
    const { diff, exitCode, ...rest } = r
    const out: Record<string, unknown> = { type: 'action' }
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v
    if (r.kind === 'edit') out.diff = diff
    if (r.kind === 'exec' && exitCode !== undefined) out.exitCode = exitCode
    return out as BlockDraft
  })

const arbPermissionDraft: fc.Arbitrary<BlockDraft> = fc
  .record({
    tool: arbToken,
    title: arbLine(),
    detail: fc.option(arbBody(), { nil: undefined }),
    options: arbPermissionOptions,
    outcome: fc.constantFrom('pending', 'accepted', 'rejected', 'cancelled' as const),
  })
  .map(({ tool, title, detail, options, outcome }) => {
    const out: Record<string, unknown> = {
      type: 'permission',
      tool,
      title,
      options,
      state: outcome,
    }
    if (detail !== undefined) out.detail = detail
    if (outcome === 'accepted') out.selectedOptionId = 'allow'
    if (outcome === 'rejected') out.selectedOptionId = 'deny'
    return out as BlockDraft
  })

const arbQuestionDraft: fc.Arbitrary<BlockDraft> = fc
  .record({
    questions: arbQuestions,
    state: fc.constantFrom('pending', 'answered', 'cancelled' as const),
    answers: arbQuestionAnswers,
  })
  .map(({ questions, state, answers }) => ({
    type: 'question' as const,
    questions,
    state,
    ...(state === 'answered' ? { answers } : {}),
  }))

/** Contenido de bloque sin identidad (lo que emite un proveedor). */
export const arbBlockDraft: fc.Arbitrary<BlockDraft> = fc.oneof(
  arbBody(1).map((text) => ({ type: 'user' as const, text })),
  fc
    .record({
      text: arbBody(),
      complete: fc.boolean(),
      truncated: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map(({ text, complete, truncated }) => ({
      type: 'text' as const,
      text,
      complete,
      ...(truncated === undefined ? {} : { truncated }),
    })),
  fc
    .record({ text: arbBody(), complete: fc.boolean() })
    .map((r) => ({ type: 'reasoning' as const, ...r })),
  arbActionDraft,
  arbPermissionDraft,
  arbQuestionDraft,
  fc
    .record({
      entries: fc.array(
        fc.record({
          text: arbLine(80),
          status: fc.constantFrom('pending', 'in-progress', 'completed' as const),
        }),
        { maxLength: 6 },
      ),
      markdown: fc.option(arbBody(), { nil: undefined }),
    })
    .map(({ entries, markdown }) => ({
      type: 'plan' as const,
      entries,
      ...(markdown === undefined ? {} : { markdown }),
    })),
  fc
    .record({
      code: arbToken,
      message: arbBody(1),
      fatal: fc.boolean(),
      retryable: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map(({ retryable, ...r }) => ({
      type: 'error' as const,
      ...r,
      ...(retryable === undefined ? {} : { retryable }),
    })),
  fc
    .record({
      stopReason: fc.constantFrom(
        'end-turn',
        'max-tokens',
        'max-turns',
        'refusal',
        'interrupted',
        'error',
        'other' as const,
      ),
      usage: arbTurnUsage,
    })
    .map((r) => ({ type: 'usage' as const, ...r })),
)

/** Bloque completo: contenido + id estable, índice, turno, `seq` y marca de tiempo. */
export const arbBlock: fc.Arbitrary<Block> = fc
  .record({
    draft: arbBlockDraft,
    id: arbBlockId,
    index: fc.integer({ min: 0, max: 9999 }),
    turn: fc.integer({ min: 0, max: 1000 }),
    seq: fc.integer({ min: 0, max: 1000 }),
    createdAt: arbMs,
  })
  .map(({ draft, ...base }) => ({ ...draft, ...base }) as Block)

export const arbProviderCapabilities: fc.Arbitrary<ProviderCapabilities> = fc.record(
  {
    models: fc.array(fc.record({ id: arbToken, label: arbLine(30) }, { requiredKeys: ['id'] }), {
      maxLength: 4,
    }),
    efforts: fc.array(arbToken, { maxLength: 4 }),
    permissionModes: fc.uniqueArray(
      fc.constantFrom('ask', 'accept-edits', 'plan', 'bypass' as const),
      {
        minLength: 1,
      },
    ),
    resume: fc.boolean(),
    warmup: fc.boolean(),
    streaming: fc.boolean(),
  },
  { requiredKeys: ['models', 'efforts', 'permissionModes', 'resume', 'warmup', 'streaming'] },
) as fc.Arbitrary<ProviderCapabilities>

export const arbAgentSession: fc.Arbitrary<AgentSession> = fc
  .record(
    {
      id: arbAgentSessionId,
      provider: fc.constantFrom('claude', 'codex', 'gemini', 'antigravity', 'ollama'),
      providerSessionId: arbToken,
      paneId: id.map((s) => PaneId.parse(s)),
      title: arbLine(),
      model: arbToken,
      effort: arbToken,
      permissionMode: fc.constantFrom('ask', 'accept-edits', 'plan', 'bypass' as const),
      cwd: fc.constantFrom('/work', 'C:\\work', '/home/u/proyecto'),
      status: fc.constantFrom('idle', 'working', 'needs-input', 'done', 'error' as const),
      turn: fc.integer({ min: 0, max: 1000 }),
      blockCount: fc.integer({ min: 0, max: 10_000 }),
      createdAt: arbMs,
      updatedAt: arbMs,
    },
    {
      requiredKeys: [
        'id',
        'provider',
        'paneId',
        'permissionMode',
        'cwd',
        'status',
        'turn',
        'blockCount',
        'createdAt',
        'updatedAt',
      ],
    },
  )
  .map((s) => AgentSession.parse(s))

export const arbAgentDelta: fc.Arbitrary<AgentDelta> = fc.record({
  sessionId: arbAgentSessionId,
  blockId: arbBlockId,
  field: fc.constantFrom('text', 'output' as const),
  seq: fc.integer({ min: 1, max: 10_000 }),
  text: arbBody(1),
})

const ref = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/)

/** Eventos de proveedor válidos de todos los tipos. */
export const arbProviderEvent: fc.Arbitrary<ProviderEvent> = fc.oneof(
  fc
    .record(
      { providerSessionId: arbToken, model: arbToken, title: arbLine() },
      { requiredKeys: [] },
    )
    .map((r) => ({ type: 'session-info' as const, ...r })),
  fc.record({ ref, block: arbBlockDraft }).map((r) => ({ type: 'block-start' as const, ...r })),
  fc
    .record({ ref, field: fc.constantFrom('text', 'output' as const), text: arbBody(1) })
    .map((r) => ({ type: 'block-delta' as const, ...r })),
  fc.record({ ref, block: arbBlockDraft }).map((r) => ({ type: 'block-update' as const, ...r })),
  fc.record({ ref }).map((r) => ({ type: 'block-end' as const, ...r })),
  fc.record({ ref, block: arbBlockDraft }).map((r) => ({ type: 'block-end' as const, ...r })),
  fc
    .record({ requestId: ref, tool: arbToken, title: arbLine(), options: arbPermissionOptions })
    .map((r) => ({ type: 'permission-request' as const, ...r })),
  fc
    .record({ requestId: ref, questions: arbQuestions })
    .map((r) => ({ type: 'question-request' as const, ...r })),
  fc.record({ requestId: ref }).map((r) => ({ type: 'request-cancelled' as const, ...r })),
  arbTurnUsage.map((usage) => ({ type: 'usage' as const, usage })),
  fc
    .record({
      stopReason: fc.constantFrom('end-turn', 'interrupted', 'error' as const),
      usage: arbTurnUsage,
    })
    .map((r) => ({ type: 'turn-end' as const, ...r })),
  fc
    .record({ code: arbToken, message: arbBody(1), fatal: fc.boolean() })
    .map((error) => ({ type: 'error' as const, error })),
  fc
    .record({
      exitCode: fc.option(fc.integer({ min: -255, max: 255 }), { nil: null }),
      signal: fc.option(fc.constantFrom('SIGTERM', 'SIGKILL'), { nil: null }),
    })
    .map((r) => ({ type: 'exit' as const, ...r })),
) as fc.Arbitrary<ProviderEvent>

function req<M extends MethodName>(
  method: M,
  params: fc.Arbitrary<MethodParams<M>>,
): fc.Arbitrary<TypedRequest> {
  return fc
    .record({ id: fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/), params })
    .map(({ id: i, params: p }) => ({ v: 1, id: i, method, params: p }) as TypedRequest)
}

const sessionOnly = fc.record({ sessionId: arbAgentSessionId })

/** Peticiones válidas de los métodos `agent.*`. */
export const arbAgentRequest: fc.Arbitrary<TypedRequest> = fc.oneof(
  req('agent.providers', fc.constant({})),
  req(
    'agent.create',
    fc.record(
      {
        paneId: id.map((s) => PaneId.parse(s)),
        provider: fc.constantFrom('claude', 'codex', 'ollama'),
        cwd: fc.constantFrom('/work', 'C:\\work'),
        model: arbToken,
        effort: arbToken,
        permissionMode: fc.constantFrom('ask', 'plan' as const),
      },
      { requiredKeys: ['paneId', 'provider'] },
    ),
  ),
  req('agent.send', fc.record({ sessionId: arbAgentSessionId, text: arbBody(1) })),
  req('agent.interrupt', sessionOnly),
  req(
    'agent.respond',
    fc.oneof(
      fc.record({
        type: fc.constant('permission' as const),
        sessionId: arbAgentSessionId,
        blockId: arbBlockId,
        optionId: localId,
      }),
      fc.record({
        type: fc.constant('question' as const),
        sessionId: arbAgentSessionId,
        blockId: arbBlockId,
        answers: arbQuestionAnswers,
      }),
    ),
  ),
  req('agent.list', fc.constant({})),
  req(
    'agent.snapshot',
    fc.record(
      {
        sessionId: arbAgentSessionId,
        fromIndex: fc.nat(1000),
        limit: fc.integer({ min: 1, max: 200 }),
      },
      { requiredKeys: ['sessionId'] },
    ),
  ),
  req('agent.close', sessionOnly),
)

function ev(event: TypedEvent['event'], data: fc.Arbitrary<unknown>): fc.Arbitrary<TypedEvent> {
  return fc
    .record({ seq: fc.nat({ max: 2 ** 31 }), data })
    .map(({ seq, data: d }) => ({ v: 1, event, seq, data: d }) as TypedEvent)
}

/** Eventos `agent.*` válidos. */
export const arbAgentEvent: fc.Arbitrary<TypedEvent> = fc.oneof(
  ev('agent.block', fc.record({ sessionId: arbAgentSessionId, block: arbBlock })),
  ev('agent.delta', arbAgentDelta),
  ev(
    'agent.status',
    fc.record(
      {
        sessionId: arbAgentSessionId,
        status: fc.constantFrom('idle', 'working', 'needs-input', 'done', 'error' as const),
        updatedAt: arbMs,
        reason: arbLine(),
      },
      { requiredKeys: ['sessionId', 'status', 'updatedAt'] },
    ),
  ),
  ev(
    'agent.session',
    arbAgentSession.map((session) => ({ session })),
  ),
  ev(
    'agent.session',
    arbAgentSessionId.map((sessionId) => ({ sessionId, removed: true as const })),
  ),
)
