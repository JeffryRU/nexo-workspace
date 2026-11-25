import {
  type Attention,
  EVENT_NAMES,
  type EventName,
  type Layout,
  type MethodName,
  type MethodParams,
  type Pane,
  PaneId,
  type ServerMessage,
  type SplitDirection,
  type Tab,
  TabId,
  TerminalId,
  type TypedEvent,
  type TypedRequest,
  type Workspace,
  WorkspaceId,
} from '@nexo/contracts'
import * as fc from 'fast-check'
import { arbAgentEvent, arbAgentRequest } from './arbitraries-agent.ts'

const arbIdString = fc.stringMatching(/^[A-Za-z0-9_-]{1,32}$/)

export const arbWorkspaceId = arbIdString.map((s) => WorkspaceId.parse(s))
export const arbTabId = arbIdString.map((s) => TabId.parse(s))
export const arbPaneId = arbIdString.map((s) => PaneId.parse(s))
export const arbTerminalId = arbIdString.map((s) => TerminalId.parse(s))
export const arbDirection: fc.Arbitrary<SplitDirection> = fc.constantFrom('row', 'column')
export const arbAttention: fc.Arbitrary<Attention> = fc.constantFrom(
  'idle',
  'working',
  'needs-input',
  'done',
  'error',
)

/** Texto de una línea válido para títulos y nombres. */
export const arbTitle = fc
  .stringMatching(/^[A-Za-z0-9 áéíóúñ._-]{1,60}$/)
  .filter((s) => s.length > 0)

/** Cadenas hostiles: escapes ANSI/OSC, NUL, bidi, sustitutos sueltos, enormes, claves de prototipo. */
export const arbHostileString: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    '\u001b[31mrojo\u001b[0m',
    '\u001b]0;título falso\u0007',
    '\u001b]52;c;ZXZpbA==\u0007',
    '\u001b[2J\u001b[H',
    '\u0000',
    'a\u0000b',
    '\u009b31m',
    '\u202eoverride',
    '\ud800',
    '\udfff solo',
    '😀'.repeat(50),
    '__proto__',
    'constructor',
    'prototype',
    '../../etc/passwd',
    '..\\..\\Windows\\System32',
    '\\\\?\\C:\\secret',
    '\r\n',
    '%00',
    ' ',
    '',
  ),
  fc.string({ unit: 'binary', maxLength: 200 }),
  fc.integer({ min: 1, max: 6000 }).map((n) => 'A'.repeat(n)),
)

/** JSON arbitrario con claves de prototipo y valores hostiles mezclados. */
export const arbHostileJson: fc.Arbitrary<unknown> = fc.oneof(
  fc.jsonValue({ maxDepth: 4 }),
  fc.constantFrom<unknown>(
    null,
    [],
    {},
    { __proto__: { polluted: true } },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
    { v: 1, id: '', method: 'daemon.info' },
    { v: 2, id: 'a', method: 'daemon.info' },
    { v: 1, id: 'a', method: 'terminal.write', params: { terminalId: 't', data: 5 } },
    { v: 1, id: 'a', method: '__proto__', params: {} },
    { v: 1, id: 'a', method: 'constructor', params: {} },
    { v: 1, id: 1, ok: true, result: null },
    { v: 1, event: 'layout.changed', seq: -1, data: {} },
  ),
  fc.dictionary(
    fc.constantFrom('__proto__', 'constructor', 'v', 'id', 'method', 'params'),
    fc.jsonValue({ maxDepth: 2 }),
  ),
)

/** Estructura de un árbol sin ids; se materializa con ids únicos en `arbLayout`. */
type Shape =
  | { leaf: true }
  | { leaf: false; direction: SplitDirection; weights: number[]; children: Shape[] }

export type ArbLayoutOptions = { maxLeaves?: number }

/** Árboles de distribución válidos (ids únicos, proporciones que suman 1, >= 2 hijos por división). */
export function arbLayout(options: ArbLayoutOptions = {}): fc.Arbitrary<Layout> {
  const maxLeaves = options.maxLeaves ?? 12
  const shape = fc.letrec<{ node: Shape }>((tie) => ({
    node: fc.oneof(
      { depthSize: 'small', maxDepth: 4 },
      fc.constant<Shape>({ leaf: true }),
      fc.record({
        leaf: fc.constant(false as const),
        direction: arbDirection,
        weights: fc.array(fc.double({ min: 0.1, max: 1, noNaN: true }), {
          minLength: 2,
          maxLength: 4,
        }),
        children: fc.array(tie('node'), { minLength: 4, maxLength: 4 }),
      }),
    ),
  })).node
  return shape.map((root) => materialize(root, maxLeaves))
}

function materialize(root: Shape, maxLeaves: number): Layout {
  let next = 0
  const build = (s: Shape, budget: { left: number }): Layout => {
    if (s.leaf || budget.left < 2) return { type: 'leaf', paneId: PaneId.parse(`p${next++}`) }
    const count = Math.min(s.weights.length, budget.left)
    budget.left -= count - 1
    const weights = s.weights.slice(0, count)
    const sum = weights.reduce((a, b) => a + b, 0)
    return {
      type: 'split',
      direction: s.direction,
      children: weights.map((_, i) => build(s.children[i] ?? { leaf: true }, budget)),
      ratios: weights.map((w) => w / sum),
    }
  }
  return build(root, { left: maxLeaves })
}

export const arbLayoutPaneIds = (layout: Layout): PaneId[] => {
  const out: PaneId[] = []
  const stack: Layout[] = [layout]
  while (stack.length > 0) {
    const n = stack.pop()
    if (n === undefined) break
    if (n.type === 'leaf') out.push(n.paneId)
    else stack.push(...n.children)
  }
  return out
}

export const arbPane: fc.Arbitrary<Pane> = fc.record(
  {
    id: arbPaneId,
    kind: fc.constantFrom('terminal' as const, 'agent' as const),
    title: arbTitle,
    terminalId: arbTerminalId,
    attention: arbAttention,
  },
  { requiredKeys: ['id', 'kind', 'title', 'attention'] },
)

export const arbTab: fc.Arbitrary<Tab> = fc
  .record({ id: arbTabId, title: arbTitle, layout: arbLayout(), attention: arbAttention })
  .map(({ id, title, layout, attention }) => {
    const ids = arbLayoutPaneIds(layout)
    const panes: Pane[] = ids.map((paneId) => ({
      id: paneId,
      kind: 'terminal',
      title: 'Terminal',
      attention,
    }))
    return { id, title, layout, panes, focusedPaneId: ids[0] as PaneId }
  })

export const arbWorkspace: fc.Arbitrary<Workspace> = fc
  .record({ id: arbWorkspaceId, name: arbTitle, tabs: fc.array(arbTab, { maxLength: 3 }) })
  .map((w) => ({ ...w, ...(w.tabs[0] === undefined ? {} : { activeTabId: w.tabs[0].id }) }))

const cols = fc.integer({ min: 1, max: 1000 })

function req<M extends MethodName>(
  method: M,
  params: fc.Arbitrary<MethodParams<M>>,
): fc.Arbitrary<TypedRequest> {
  return fc
    .record({ id: fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/), params })
    .map(({ id, params: p }) => ({ v: 1, id, method, params: p }) as TypedRequest)
}

/** Peticiones válidas de cualquier método del registro. */
export const arbRequest: fc.Arbitrary<TypedRequest> = fc.oneof(
  arbAgentRequest,
  req('daemon.info', fc.constant({})),
  req('daemon.shutdown', fc.constant({})),
  req('snapshot', fc.constant({})),
  req(
    'events.subscribe',
    fc.record(
      { events: fc.array(fc.constantFrom(...EVENT_NAMES), { maxLength: 5 }) },
      { requiredKeys: [] },
    ),
  ),
  req('workspace.list', fc.constant({})),
  req('workspace.create', fc.record({ name: arbTitle }, { requiredKeys: ['name'] })),
  req('workspace.rename', fc.record({ workspaceId: arbWorkspaceId, name: arbTitle })),
  req('workspace.close', fc.record({ workspaceId: arbWorkspaceId })),
  req('tab.create', fc.record({ workspaceId: arbWorkspaceId }, { requiredKeys: ['workspaceId'] })),
  req('tab.close', fc.record({ tabId: arbTabId })),
  req('tab.focus', fc.record({ tabId: arbTabId })),
  req('tab.move', fc.record({ tabId: arbTabId, index: fc.integer({ min: 0, max: 1023 }) })),
  req('tab.rename', fc.record({ tabId: arbTabId, title: arbTitle })),
  req(
    'pane.split',
    fc.record(
      {
        paneId: arbPaneId,
        direction: arbDirection,
        ratio: fc.double({ min: 0.01, max: 0.99, noNaN: true }),
      },
      { requiredKeys: ['paneId', 'direction'] },
    ),
  ),
  req('pane.close', fc.record({ paneId: arbPaneId })),
  req('pane.focus', fc.record({ paneId: arbPaneId })),
  req(
    'pane.resize',
    fc.oneof(
      fc.record({ paneId: arbPaneId, delta: fc.double({ min: -1, max: 1, noNaN: true }) }),
      fc.record({
        tabId: arbTabId,
        path: fc.array(fc.nat(5), { maxLength: 6 }),
        index: fc.nat(5),
        delta: fc.double({ min: -1, max: 1, noNaN: true }),
      }),
    ),
  ),
  req('pane.swap', fc.record({ paneId: arbPaneId, otherPaneId: arbPaneId })),
  req(
    'terminal.spawn',
    fc.record(
      {
        paneId: arbPaneId,
        cmd: fc.constantFrom('bash', 'pwsh'),
        args: fc.array(arbIdString, { maxLength: 4 }),
        cols,
        rows: cols,
      },
      { requiredKeys: ['paneId', 'cols', 'rows'] },
    ),
  ),
  req(
    'terminal.write',
    fc.record({ terminalId: arbTerminalId, data: fc.string({ maxLength: 2000 }) }),
  ),
  req('terminal.resize', fc.record({ terminalId: arbTerminalId, cols, rows: cols })),
  req('terminal.read', fc.record({ terminalId: arbTerminalId }, { requiredKeys: ['terminalId'] })),
  req('terminal.kill', fc.record({ terminalId: arbTerminalId }, { requiredKeys: ['terminalId'] })),
)

function ev<E extends EventName>(
  event: E,
  data: fc.Arbitrary<TypedEvent['data']>,
): fc.Arbitrary<TypedEvent> {
  return fc
    .record({ seq: fc.nat({ max: 2 ** 31 }), data })
    .map(({ seq, data: d }) => ({ v: 1, event, seq, data: d }) as TypedEvent)
}

export const arbEvent: fc.Arbitrary<TypedEvent> = fc.oneof(
  arbAgentEvent,
  ev(
    'layout.changed',
    fc.record({ workspaceId: arbWorkspaceId, tab: arbTab }).map(({ workspaceId, tab }) => ({
      workspaceId,
      tabId: tab.id,
      layout: tab.layout,
      focusedPaneId: tab.focusedPaneId,
      panes: tab.panes,
    })),
  ),
  ev(
    'terminal.output',
    fc.record({ terminalId: arbTerminalId, offset: fc.nat(), data: fc.string({ maxLength: 500 }) }),
  ),
  ev(
    'terminal.exit',
    fc.record({
      terminalId: arbTerminalId,
      exitCode: fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }),
      signal: fc.option(fc.constantFrom('SIGTERM', 'SIGKILL'), { nil: null }),
    }),
  ),
  ev('pane.title', fc.record({ paneId: arbPaneId, title: arbTitle })),
  ev('pane.attention', fc.record({ paneId: arbPaneId, attention: arbAttention })),
)

/** true si algún objeto anidado tiene una clave propia `__proto__` (el protocolo la rechaza). */
export function hasProtoKey(value: unknown): boolean {
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === null || typeof current !== 'object') continue
    if (Object.hasOwn(current, '__proto__')) return true
    stack.push(...Object.values(current))
  }
  return false
}

/** JSON arbitrario que el protocolo acepta: sin claves `__proto__`. */
export const arbProtocolJson = (maxDepth: number): fc.Arbitrary<fc.JsonValue> =>
  fc.jsonValue({ maxDepth }).filter((v) => !hasProtoKey(v))

/** Mensajes daemon -> cliente válidos: respuestas ok, errores y eventos. */
export const arbServerMessage: fc.Arbitrary<ServerMessage> = fc.oneof(
  arbEvent,
  fc.record({
    v: fc.constant(1 as const),
    id: fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/),
    ok: fc.constant(true as const),
    result: arbProtocolJson(3),
  }),
  fc.record({
    v: fc.constant(1 as const),
    id: fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/),
    ok: fc.constant(false as const),
    error: fc.record({
      code: fc.constantFrom('INVALID_PARAMS' as const, 'NOT_FOUND' as const, 'INTERNAL' as const),
      message: fc.string({ maxLength: 100 }),
    }),
  }),
)

/** Corrompe un texto JSON: cambia, borra, inserta o trunca. */
export function arbMutated(text: string): fc.Arbitrary<string> {
  return fc
    .record({
      pos: fc.nat({ max: Math.max(0, text.length) }),
      len: fc.integer({ min: 0, max: 8 }),
      op: fc.constantFrom('replace', 'delete', 'insert', 'truncate', 'duplicate'),
      ins: arbHostileString,
    })
    .map(({ pos, len, op, ins }) => {
      switch (op) {
        case 'replace':
          return text.slice(0, pos) + ins.slice(0, len + 1) + text.slice(pos + len)
        case 'delete':
          return text.slice(0, pos) + text.slice(pos + len + 1)
        case 'insert':
          return text.slice(0, pos) + ins + text.slice(pos)
        case 'truncate':
          return text.slice(0, pos)
        default:
          return text.slice(0, pos) + text.slice(pos, pos + len + 1).repeat(3) + text.slice(pos)
      }
    })
}
