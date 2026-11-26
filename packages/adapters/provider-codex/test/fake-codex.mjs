#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
// Servidor `codex app-server` falso para las pruebas: habla JSON-RPC por líneas (sin el campo `jsonrpc`, como
// el real) y responde según la primera palabra del mensaje del usuario. Si existe FAKE_CODEX_LOG, anota ahí
// (JSONL) cada línea que recibe y los argumentos con los que lo lanzaron.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.FAKE_CODEX_LOG
const note = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}
note({ argv: process.argv.slice(2), cwd: '~/proyecto' })

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const raw = (text) => process.stdout.write(text)
const notify = (method, params) => out({ method, params })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.argv[2] !== 'app-server') {
  process.stderr.write('uso: codex app-server\n')
  process.exit(2)
}

const threadId = randomUUID()
let turnCount = 0
let current // { id, mode, interrupted, resolveInterrupt }
let serverIds = 0
const waiting = new Map() // id de solicitud al cliente -> resolve

const logged = process.env.FAKE_CODEX_LOGGED_OUT !== '1'

function ask(method, params) {
  const id = `srv-${++serverIds}`
  out({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

const base = (turn) => ({ threadId, turnId: turn.id })
const item = (turn, it, kind) =>
  notify(kind, {
    ...base(turn),
    item: it,
    [kind === 'item/started' ? 'startedAtMs' : 'completedAtMs']: 1,
  })

function usage(turn, total) {
  notify('thread/tokenUsage/updated', {
    ...base(turn),
    tokenUsage: {
      total: {
        totalTokens: total.input + total.output,
        inputTokens: total.input,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: total.output,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 10,
        inputTokens: 6,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 4,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: null,
    },
  })
}

const done = (turn, status = 'completed', error = null) =>
  notify('turn/completed', {
    threadId,
    turn: { id: turn.id, items: [], status, error, startedAt: 1, completedAt: 2, durationMs: 1234 },
  })

const agentMessage = (id, text) => ({
  type: 'agentMessage',
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
})

async function runTurn(turn, text) {
  const mode = text.split(/\s+/)[0]
  notify('turn/started', {
    threadId,
    turn: { id: turn.id, items: [], status: 'inProgress', error: null },
  })
  switch (mode) {
    case 'long': {
      item(turn, agentMessage('m1', ''), 'item/started')
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'pensando ' })
      await new Promise((r) => {
        turn.resolveInterrupt = r
      })
      if (process.env.FAKE_CODEX_HANG_ON_INTERRUPT === '1') return
      done(turn, 'interrupted')
      return
    }
    case 'hang':
      item(turn, agentMessage('m1', ''), 'item/started')
      return
    case 'permiso': {
      item(
        turn,
        {
          type: 'commandExecution',
          id: 'c1',
          pluginId: null,
          scriptPath: null,
          command: 'rm -rf build',
          cwd: '~/proyecto',
          processId: null,
          source: 'agent',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        'item/started',
      )
      const reply = await ask('item/commandExecution/requestApproval', {
        ...base(turn),
        itemId: 'c1',
        startedAtMs: 1,
        kind: 'command',
        approvalId: null,
        environmentId: null,
        reason: 'limpiar',
        command: 'rm -rf build',
        cwd: '~/proyecto',
      })
      const accepted = reply?.decision === 'accept' || reply?.decision === 'acceptForSession'
      if (turn.interrupted) {
        done(turn, 'interrupted')
        return
      }
      if (accepted)
        notify('item/commandExecution/outputDelta', {
          ...base(turn),
          itemId: 'c1',
          delta: 'borrado\n',
        })
      item(
        turn,
        {
          type: 'commandExecution',
          id: 'c1',
          pluginId: null,
          scriptPath: null,
          command: 'rm -rf build',
          cwd: '~/proyecto',
          processId: null,
          source: 'agent',
          status: accepted ? 'completed' : 'declined',
          commandActions: [],
          aggregatedOutput: accepted ? 'borrado\n' : null,
          exitCode: accepted ? 0 : null,
          durationMs: 12,
        },
        'item/completed',
      )
      item(turn, agentMessage('m1', accepted ? 'Hecho.' : 'No se ejecutó.'), 'item/completed')
      done(turn)
      return
    }
    case 'patch': {
      const reply = await ask('item/fileChange/requestApproval', {
        ...base(turn),
        itemId: 'f1',
        startedAtMs: 1,
        reason: null,
        grantRoot: null,
      })
      const ok = reply?.decision === 'accept' || reply?.decision === 'acceptForSession'
      item(
        turn,
        {
          type: 'fileChange',
          id: 'f1',
          changes: [
            {
              path: 'src/a.ts',
              kind: { type: 'update', move_path: null },
              diff: '@@ -1 +1 @@\n-a\n+b\n',
            },
          ],
          status: ok ? 'completed' : 'declined',
        },
        'item/completed',
      )
      done(turn)
      return
    }
    case 'rich': {
      notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } })
      item(turn, { type: 'reasoning', id: 'r1', summary: [], content: [] }, 'item/started')
      notify('item/reasoning/summaryPartAdded', { ...base(turn), itemId: 'r1', summaryIndex: 0 })
      notify('item/reasoning/summaryTextDelta', {
        ...base(turn),
        itemId: 'r1',
        delta: 'Primero ',
        summaryIndex: 0,
      })
      notify('item/reasoning/summaryTextDelta', {
        ...base(turn),
        itemId: 'r1',
        delta: 'miro.',
        summaryIndex: 0,
      })
      notify('item/reasoning/summaryTextDelta', {
        ...base(turn),
        itemId: 'r1',
        delta: 'Luego edito.',
        summaryIndex: 1,
      })
      item(
        turn,
        { type: 'reasoning', id: 'r1', summary: ['Primero miro.', 'Luego edito.'], content: [] },
        'item/completed',
      )
      const cmd = {
        type: 'commandExecution',
        id: 'c1',
        pluginId: null,
        scriptPath: null,
        command: 'ls -la',
        cwd: '/w',
        processId: null,
        source: 'agent',
        commandActions: [],
      }
      item(
        turn,
        { ...cmd, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null },
        'item/started',
      )
      notify('item/commandExecution/outputDelta', { ...base(turn), itemId: 'c1', delta: 'a\nb\n' })
      item(
        turn,
        { ...cmd, status: 'completed', aggregatedOutput: 'a\nb\n', exitCode: 2, durationMs: 40 },
        'item/completed',
      )
      const fc = {
        type: 'fileChange',
        id: 'f1',
        changes: [
          {
            path: 'src/a.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-a\n+b\n',
          },
        ],
      }
      item(turn, { ...fc, status: 'inProgress' }, 'item/started')
      item(turn, { ...fc, status: 'completed' }, 'item/completed')
      item(
        turn,
        {
          type: 'webSearch',
          id: 'w1',
          query: 'nexo',
          action: { type: 'search', query: 'nexo', queries: null },
          results: null,
        },
        'item/started',
      )
      item(
        turn,
        {
          type: 'webSearch',
          id: 'w1',
          query: 'nexo',
          action: { type: 'search', query: 'nexo', queries: null },
          results: null,
        },
        'item/completed',
      )
      const mcp = {
        type: 'mcpToolCall',
        id: 'k1',
        server: 'git',
        tool: 'status',
        arguments: { repo: '.' },
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        error: null,
        durationMs: null,
      }
      item(turn, { ...mcp, status: 'inProgress', result: null }, 'item/started')
      item(
        turn,
        {
          ...mcp,
          status: 'completed',
          result: {
            content: [{ type: 'text', text: 'limpio' }],
            structuredContent: null,
            _meta: null,
          },
          durationMs: 5,
        },
        'item/completed',
      )
      item(turn, { type: 'contextCompaction', id: 'x1' }, 'item/completed')
      item(turn, agentMessage('m1', ''), 'item/started')
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'Lis' })
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'to.' })
      item(turn, agentMessage('m1', 'Listo.'), 'item/completed')
      usage(turn, { input: 10, output: 4 })
      done(turn)
      return
    }
    case 'garbage': {
      raw('esto no es json\n')
      raw('[1,2,3]\n')
      raw('{"id":99999,"result":{}}\n')
      raw('{"method":"item/started","params":{"item":5}}\n')
      raw(
        '{"method":"item/agentMessage/delta","params":{"threadId":"otro","turnId":"x","itemId":"m1","delta":"ajeno"}}\n',
      )
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'inexistente', delta: 'huérfano' })
      notify('item/completed', {
        ...base(turn),
        item: { type: 'commandExecution', id: 'raro', command: 5 },
      })
      notify('item/completed', { ...base(turn), item: { type: 'tipoNuevo', id: 'n1' } })
      notify('metodo/desconocido', { a: 1 })
      out({ id: 'srv-x', method: 'item/tool/call', params: {} })
      item(turn, agentMessage('m1', 'ok'), 'item/completed')
      done(turn)
      return
    }
    case 'die':
      item(turn, agentMessage('m1', ''), 'item/started')
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'a medias' })
      process.stderr.write('panic: algo se rompió sk-abcdefghijklmnop\n')
      await sleep(20)
      process.exit(3)
      return
    case 'noisy': {
      for (let i = 0; i < 2000; i++) process.stderr.write(`ruido ${i} ${'x'.repeat(200)}\n`)
      item(turn, agentMessage('m1', 'tras el ruido'), 'item/completed')
      done(turn)
      return
    }
    case 'huge': {
      const big = 'x'.repeat(2 * 1024 * 1024)
      const cmd = {
        type: 'commandExecution',
        id: 'c1',
        pluginId: null,
        scriptPath: null,
        command: 'cat grande',
        cwd: '/w',
        processId: null,
        source: 'agent',
        commandActions: [],
      }
      item(
        turn,
        { ...cmd, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null },
        'item/started',
      )
      notify('item/commandExecution/outputDelta', { ...base(turn), itemId: 'c1', delta: big })
      item(
        turn,
        { ...cmd, status: 'completed', aggregatedOutput: big, exitCode: 0, durationMs: 1 },
        'item/completed',
      )
      done(turn)
      return
    }
    case 'toolong': {
      // Una línea que supera el tope de la conexión: se descarta, y el turno sigue.
      raw(
        `{"method":"item/agentMessage/delta","params":{"delta":"${'y'.repeat(Number(process.env.FAKE_CODEX_BIG ?? 100000))}"}}\n`,
      )
      item(turn, agentMessage('m1', 'sobrevivió'), 'item/completed')
      done(turn)
      return
    }
    case 'weird': {
      const id = '../../etc/passwd\u0000‮'
      item(turn, agentMessage(id, ''), 'item/started')
      notify('item/agentMessage/delta', { ...base(turn), itemId: id, delta: 'ho\u0000la \ud83d' })
      notify('item/agentMessage/delta', { ...base(turn), itemId: id, delta: '\ude00 fin' })
      item(turn, agentMessage(id, 'ho\u0000la 😀 fin'), 'item/completed')
      done(turn)
      return
    }
    case 'fail':
      notify('error', {
        threadId,
        turnId: turn.id,
        willRetry: true,
        error: { message: 'reconectando', codexErrorInfo: null, additionalDetails: null },
      })
      notify('error', {
        threadId,
        turnId: turn.id,
        willRetry: false,
        error: { message: 'sin sesión', codexErrorInfo: 'unauthorized', additionalDetails: null },
      })
      done(turn, 'failed', {
        message: 'sin sesión',
        codexErrorInfo: 'unauthorized',
        additionalDetails: null,
        misalignment: null,
      })
      return
    case 'lateapproval':
      await new Promise((r) => {
        turn.resolveInterrupt = r
      })
      {
        const reply = await ask('item/commandExecution/requestApproval', {
          ...base(turn),
          itemId: 'c9',
          startedAtMs: 1,
          kind: 'command',
          command: 'echo tarde',
          cwd: '/w',
        })
        note({ lateReply: reply })
      }
      done(turn, 'interrupted')
      return
    default: {
      item(turn, agentMessage('m1', ''), 'item/started')
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'Hola ' })
      notify('item/agentMessage/delta', { ...base(turn), itemId: 'm1', delta: 'mundo' })
      item(turn, agentMessage('m1', 'Hola mundo'), 'item/completed')
      usage(turn, { input: 10 * turnCount, output: 4 * turnCount })
      done(turn)
    }
  }
}

function handle(msg) {
  const { id, method, params } = msg
  if (method === undefined) {
    // Respuesta a una solicitud nuestra.
    const resolve = waiting.get(id)
    if (resolve) {
      waiting.delete(id)
      resolve(msg.result ?? { error: msg.error })
    }
    return
  }
  const reply = (result) => out({ id, result })
  const fail = (code, message) => out({ id, error: { code, message } })
  switch (method) {
    case 'initialize':
      if (process.env.FAKE_CODEX_NO_INIT === '1') return
      return reply({
        userAgent: 'fake/0.158.0',
        codexHome: '/h',
        platformFamily: 'unix',
        platformOs: 'linux',
      })
    case 'initialized':
      return
    case 'account/read':
      return reply(
        logged
          ? {
              account: { type: 'chatgpt', email: null, planType: 'free' },
              requiresOpenaiAuth: true,
            }
          : { account: null, requiresOpenaiAuth: true },
      )
    case 'model/list': {
      if (process.env.FAKE_CODEX_MODELS_FAIL === '1') return fail(-32603, 'sin modelos')
      const effs = ['low', 'medium', 'high'].map((reasoningEffort) => ({
        reasoningEffort,
        description: reasoningEffort,
      }))
      const models = [
        {
          id: 'gpt-fake',
          model: 'gpt-fake',
          displayName: 'GPT Fake',
          hidden: false,
          isDefault: true,
          supportedReasoningEfforts: effs,
          defaultReasoningEffort: 'medium',
        },
        {
          id: 'gpt-mini',
          model: 'gpt-mini',
          displayName: 'GPT Mini',
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: effs.slice(0, 1),
          defaultReasoningEffort: 'low',
        },
        {
          id: 'oculto',
          model: 'oculto',
          displayName: 'Oculto',
          hidden: true,
          isDefault: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'low',
        },
      ]
      return reply({ data: models, nextCursor: null })
    }
    case 'thread/start':
      return reply({
        thread: { id: threadId },
        model: 'gpt-fake',
        modelProvider: 'openai',
        cwd: params?.cwd,
        approvalPolicy: params?.approvalPolicy,
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: null,
      })
    case 'thread/resume':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(params?.threadId ?? ''))
        return fail(-32600, `no rollout found for thread id ${params?.threadId}`)
      return reply({
        thread: { id: params.threadId },
        model: 'gpt-fake',
        modelProvider: 'openai',
        cwd: params?.cwd,
        approvalPolicy: 'on-request',
        sandbox: { type: 'workspaceWrite' },
        reasoningEffort: null,
      })
    case 'turn/start': {
      turnCount++
      const text = params?.input?.[0]?.text ?? ''
      current = { id: randomUUID(), interrupted: false }
      const turn = current
      if (process.env.FAKE_CODEX_START_FAIL === '1') return fail(-32600, 'modelo inválido')
      reply({ turn: { id: turn.id, items: [], status: 'inProgress', error: null } })
      void runTurn(turn, text)
      return
    }
    case 'turn/interrupt':
      reply({})
      if (current && current.id === params?.turnId) {
        current.interrupted = true
        current.resolveInterrupt?.()
        // Quien espera una aprobación la recibe cancelada por el cliente.
      }
      return
    default:
      return fail(-32601, `método desconocido: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  note({ in: line.length > 4000 ? `${line.slice(0, 4000)}…` : line })
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  handle(msg)
})
rl.on('close', () => process.exit(0))
