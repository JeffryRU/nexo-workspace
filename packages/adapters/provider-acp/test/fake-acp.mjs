#!/usr/bin/env node
// Agente ACP falso para las pruebas: habla JSON-RPC 2.0 por líneas (Agent Client Protocol, versión 1) y responde
// según la primera palabra del mensaje del usuario. Se lanza con `--acp`, como Gemini CLI. Si existe
// FAKE_ACP_LOG, anota ahí (JSONL) cada línea que recibe y los argumentos con los que lo lanzaron.
//
// Variables de entorno que cambian su comportamiento:
//   FAKE_ACP_AUTH=1          sin sesión iniciada: anuncia authMethods y `session/new` falla con -32000
//   FAKE_ACP_VERSION=N       responde `initialize` con esa versión del protocolo
//   FAKE_ACP_NO_LOAD=1       no anuncia loadSession
//   FAKE_ACP_MODES=none      sin modos de sesión (por omisión: default, autoEdit, plan, yolo)
//   FAKE_ACP_MODELS=config|unstable|none   cómo anuncia los modelos (por omisión unstable)
//   FAKE_ACP_STDERR=1        ruido en stderr
//   FAKE_ACP_DIE=init        muere al recibir `initialize`
//   FAKE_ACP_HANG=init       no responde a `initialize`
//   FAKE_ACP_HANG_ON_CANCEL=1  no responde a `session/prompt` tras `session/cancel`
//   FAKE_ACP_BIG=N           bytes de la línea enorme del mensaje «grande»
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.env.FAKE_ACP_LOG
const note = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`)
}
note({ argv: process.argv.slice(2) })

if (!process.argv.includes('--acp')) {
  process.stderr.write('uso: fake-acp --acp\n')
  process.exit(2)
}
if (process.env.FAKE_ACP_STDERR === '1') {
  for (let i = 0; i < 500; i++)
    process.stderr.write(`ruido de stderr ${i} token=sk-abcdefghijklmnop${i}\n`)
}

const out = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`)
const raw = (text) => process.stdout.write(text)
const respond = (id, result) => out({ id, result })
const fail = (id, code, message, data) =>
  out({ id, error: { code, message, ...(data ? { data } : {}) } })
const notify = (method, params) => out({ method, params })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Carpeta de los archivos que el agente dice tocar: una ficticia, o (FAKE_ACP_ROOT=cwd) la de la sesión.
let sessionCwd = ''
const root = () => (process.env.FAKE_ACP_ROOT === 'cwd' ? sessionCwd : '/proyecto')
const update = (sessionId, u) => notify('session/update', { sessionId, update: u })
const chunk = (sessionId, kind, text) =>
  update(sessionId, { sessionUpdate: kind, content: { type: 'text', text } })

const MODES = [
  { id: 'default', name: 'Default' },
  { id: 'autoEdit', name: 'Auto Edit' },
  { id: 'plan', name: 'Plan' },
  { id: 'yolo', name: 'YOLO' },
]
const MODELS = [
  { modelId: 'fake-pro', name: 'Fake Pro' },
  { modelId: 'fake-flash', name: 'Fake Flash' },
]

let sessions = 0
const known = new Set()
const modes = new Map() // sessionId -> modo actual
const models = new Map()
let nextServerId = 0
const waiting = new Map() // id de solicitud al cliente -> resolve
let current // { id, sessionId, cancelled, resolveCancel }

function sessionPayload(sessionId) {
  const payload = {}
  if (process.env.FAKE_ACP_MODES !== 'none') {
    payload.modes = {
      currentModeId: modes.get(sessionId) ?? 'default',
      availableModes: MODES,
    }
  }
  const style = process.env.FAKE_ACP_MODELS ?? 'unstable'
  if (style === 'unstable') {
    payload.models = {
      currentModelId: models.get(sessionId) ?? 'fake-pro',
      availableModels: MODELS,
    }
  } else if (style === 'config') {
    payload.configOptions = [
      {
        id: 'model',
        name: 'Modelo',
        type: 'select',
        category: 'model',
        currentValue: models.get(sessionId) ?? 'fake-pro',
        options: [
          { value: 'fake-pro', name: 'Fake Pro' },
          { group: 'g', name: 'Grupo', options: [{ value: 'fake-flash', name: 'Fake Flash' }] },
        ],
      },
    ]
  }
  return payload
}

function askClient(method, params) {
  const id = 9000 + ++nextServerId
  out({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}

const permissionOptions = [
  { optionId: 'allow-1', name: 'Permitir', kind: 'allow_once' },
  { optionId: 'always-1', name: 'Permitir siempre', kind: 'allow_always' },
  { optionId: 'reject-1', name: 'Rechazar', kind: 'reject_once' },
]

async function runPrompt(id, sessionId, text) {
  const mode = text.split(/\s+/)[0]
  const turn = { id, sessionId, cancelled: false, resolveCancel: undefined }
  current = turn
  const done = (stopReason = 'end_turn', extra = {}) => {
    if (current === turn) current = undefined
    respond(id, { stopReason, ...extra })
  }
  switch (mode) {
    case 'simple':
      update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [] })
      update(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
      chunk(sessionId, 'agent_message_chunk', 'Hola ')
      chunk(sessionId, 'agent_message_chunk', 'desde ACP.')
      update(sessionId, { sessionUpdate: 'usage_update', used: 10, size: 1000 })
      return done('end_turn', {
        usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10, thoughtTokens: 3 },
      })
    case 'long': {
      chunk(sessionId, 'agent_thought_chunk', 'pensando ')
      chunk(sessionId, 'agent_message_chunk', 'espera ')
      await new Promise((r) => {
        turn.resolveCancel = r
      })
      if (process.env.FAKE_ACP_HANG_ON_CANCEL === '1') return
      return done('cancelled')
    }
    case 'hang':
      chunk(sessionId, 'agent_message_chunk', 'colgado')
      return
    // Salida continua (para medir la interfaz con varios proveedores emitiendo a la vez).
    case 'stream': {
      const n = Number(process.env.FAKE_ACP_STREAM_N ?? 300)
      for (let i = 0; i < n; i++) {
        chunk(sessionId, 'agent_message_chunk', 'palabra ')
        await sleep(Number(process.env.FAKE_ACP_STREAM_MS ?? 10))
      }
      return done('end_turn')
    }
    case 'permiso': {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Ejecutar: rm -rf build',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'rm -rf build' },
      })
      const reply = await askClient('session/request_permission', {
        sessionId,
        toolCall: {
          toolCallId: 'c1',
          title: 'Ejecutar: rm -rf build',
          kind: 'execute',
          rawInput: { command: 'rm -rf build' },
        },
        options: permissionOptions,
      })
      note({ permissionReply: reply })
      if (
        reply?.outcome?.outcome === 'selected' &&
        /^(allow|always)/.test(reply.outcome.optionId)
      ) {
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'in_progress',
        })
        update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'c1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'listo' } }],
          rawOutput: { exitCode: 0 },
        })
        chunk(sessionId, 'agent_message_chunk', 'Hecho.')
        return done('end_turn')
      }
      if (reply?.outcome?.outcome === 'cancelled') return done('cancelled')
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' })
      chunk(sessionId, 'agent_message_chunk', 'No se ejecutó.')
      return done('end_turn')
    }
    case 'latepermiso': {
      // Pide permiso después de que el cliente cancelara: el cliente debe responder `cancelled` sin mostrarlo.
      await new Promise((r) => {
        turn.resolveCancel = r
      })
      const reply = await askClient('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'late', title: 'Tarde' },
        options: permissionOptions,
      })
      note({ lateReply: reply })
      return done('cancelled')
    }
    case 'rich': {
      chunk(sessionId, 'agent_thought_chunk', 'Pienso en el plan.')
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Leer el archivo', priority: 'high', status: 'completed' },
          { content: 'Editar el archivo', priority: 'medium', status: 'in_progress' },
          { content: 'Probar', priority: 'low', status: 'pending' },
        ],
      })
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'r1',
        title: 'Leer src/a.ts',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: `${root()}/src/a.ts`, line: 1 }],
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'r1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'const a = 1' } }],
      })
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        title: 'Editar src/a.ts',
        kind: 'edit',
        status: 'pending',
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: `${root()}/src/a.ts`,
            oldText: 'const a = 1\nconst b = 2\n',
            newText: 'const a = 10\nconst b = 2\nconst c = 3\n',
          },
        ],
      })
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'x1',
        title: 'Ejecutar: pnpm test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'pnpm test' },
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'x1',
        status: 'failed',
        rawOutput: { exitCode: 1, stdout: 'falló' },
        content: [{ type: 'content', content: { type: 'text', text: '1 prueba falló' } }],
      })
      update(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Leer el archivo', priority: 'high', status: 'completed' },
          { content: 'Editar el archivo', priority: 'medium', status: 'completed' },
          { content: 'Probar', priority: 'low', status: 'in_progress' },
        ],
      })
      chunk(sessionId, 'agent_message_chunk', 'Listo: **editado**.')
      return done('end_turn')
    }
    case 'editar': {
      update(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'e1',
        title: 'Editar a.txt',
        kind: 'edit',
        status: 'in_progress',
      })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'e1',
        status: 'completed',
        content: [{ type: 'diff', path: `${root()}/a.txt`, oldText: null, newText: 'hola\n' }],
      })
      chunk(sessionId, 'agent_message_chunk', 'Edición aplicada.')
      return done('end_turn')
    }
    case 'huerfano':
      // `tool_call_update` sin su `tool_call`.
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'zz',
        title: 'Sin alta',
        status: 'completed',
        kind: 'read',
      })
      chunk(sessionId, 'agent_message_chunk', 'seguí.')
      return done('end_turn')
    case 'basura': {
      update(sessionId, { sessionUpdate: 'algo_nuevo', x: 1 })
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 42 })
      update(sessionId, { sessionUpdate: 'tool_call', title: 'sin id' })
      update(sessionId, { sessionUpdate: 'agent_message_chunk' })
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: 'texto suelto' })
      update(sessionId, { sessionUpdate: 'plan', entries: 'no es una lista' })
      update(sessionId, { sessionUpdate: 'plan', entries: [{ nada: 1 }, 7, null] })
      update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 99 })
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'k1',
        status: 'rareza',
        kind: 'inventado',
        rawInput: { a: [1, 2, { b: null }] },
      })
      notify('session/update', {
        sessionId: 'otra-sesion',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'AJENO' } },
      })
      notify('session/update', 'no soy un objeto')
      notify('metodo/desconocido', { x: 1 })
      raw('esto no es json\n')
      raw('{"jsonrpc":"2.0","id":123456,"result":{}}\n')
      chunk(sessionId, 'agent_message_chunk', 'sobreviví.')
      return done('end_turn')
    }
    case 'grande': {
      const size = Number(process.env.FAKE_ACP_BIG ?? 3 * 1024 * 1024)
      raw(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(size) } } } })}\n`,
      )
      chunk(sessionId, 'agent_message_chunk', 'después de la línea enorme')
      return done('end_turn')
    }
    case 'morir':
      chunk(sessionId, 'agent_message_chunk', 'me muero ')
      await sleep(30)
      process.stderr.write('fallo fatal con ACCESS_TOKEN=abcdefghijklmnop1234\n')
      process.exit(3)
      return
    case 'error':
      if (current === turn) current = undefined
      return fail(id, -32603, 'fallo interno del agente')
    case 'auth':
      if (current === turn) current = undefined
      return fail(id, -32000, 'Authentication required')
    case 'modo': {
      chunk(sessionId, 'agent_message_chunk', `modo=${modes.get(sessionId) ?? 'default'}`)
      update(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: 'yolo' })
      update(sessionId, { sessionUpdate: 'session_info_update', title: 'Título del agente' })
      return done('end_turn')
    }
    case 'fs': {
      // Pide cosas que Nexo no ofrece (`fs`, `terminal`): debe recibir «método no encontrado».
      const fsReply = await askClient('fs/read_text_file', { sessionId, path: '/etc/passwd' })
      const termReply = await askClient('terminal/create', { sessionId, command: 'ls' })
      note({ fsReply, termReply })
      chunk(sessionId, 'agent_message_chunk', 'sin fs')
      return done('end_turn')
    }
    case 'tope':
      return done('max_tokens')
    case 'rechazo':
      return done('refusal')
    case 'tarde':
      // Responde y después sigue enviando actualizaciones del turno que ya terminó.
      chunk(sessionId, 'agent_message_chunk', 'fin')
      done('end_turn')
      await sleep(10)
      chunk(sessionId, 'agent_message_chunk', 'DESPUES')
      return
    default:
      chunk(sessionId, 'agent_message_chunk', `Eco: ${text}`)
      return done('end_turn')
  }
}

function onRequest(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize': {
      if (process.env.FAKE_ACP_DIE === 'init') process.exit(4)
      if (process.env.FAKE_ACP_HANG === 'init') return
      const version = Number(process.env.FAKE_ACP_VERSION ?? 1)
      return respond(id, {
        protocolVersion: version,
        agentCapabilities: {
          loadSession: process.env.FAKE_ACP_NO_LOAD !== '1',
          ...(process.env.FAKE_ACP_LIST === '1' ? { sessionCapabilities: { list: {} } } : {}),
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
        authMethods:
          process.env.FAKE_ACP_AUTH === '1'
            ? [{ id: 'oauth-personal', name: 'Iniciar sesión con Google' }]
            : [],
        agentInfo: { name: 'fake-acp', version: '1.0.0' },
      })
    }
    case 'session/new': {
      if (process.env.FAKE_ACP_AUTH === '1') return fail(id, -32000, 'Authentication required')
      const sessionId = `fake-session-${++sessions}`
      known.add(sessionId)
      sessionCwd = String(params?.cwd ?? '').replace(/[\\/]+$/, '')
      note({ sessionNew: params })
      return respond(id, { sessionId, ...sessionPayload(sessionId) })
    }
    case 'session/list': {
      // Historial (F4.3): sesiones sembradas en FAKE_ACP_SESSIONS_FILE; FAKE_ACP_LIST_RAW fuerza la respuesta.
      if (process.env.FAKE_ACP_HISTORY_HANG === '1') return
      if (process.env.FAKE_ACP_LIST_FAIL === '1') return fail(id, -32603, 'fallo interno')
      if (process.env.FAKE_ACP_LIST_RAW)
        return respond(id, JSON.parse(process.env.FAKE_ACP_LIST_RAW))
      let all = []
      try {
        all = JSON.parse(readFileSync(process.env.FAKE_ACP_SESSIONS_FILE ?? '', 'utf8'))
      } catch {}
      if (params?.cwd) all = all.filter((x) => x.cwd === params.cwd)
      all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      const from = Number(params?.cursor ?? 0)
      const size = Number(process.env.FAKE_ACP_PAGE ?? 1000)
      note({ sessionList: params ?? null })
      return respond(id, {
        sessions: all.slice(from, from + size),
        nextCursor: from + size < all.length ? String(from + size) : null,
      })
    }
    case 'session/load': {
      note({ sessionLoad: params })
      if (!/^fake-session-\d+$/.test(params?.sessionId ?? '')) {
        return fail(id, -32002, 'Resource not found', { sessionId: params?.sessionId })
      }
      known.add(params.sessionId)
      // Reproduce el historial antes de responder, como pide el protocolo.
      update(params.sessionId, {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'pregunta vieja' },
      })
      chunk(params.sessionId, 'agent_message_chunk', 'respuesta vieja')
      return respond(id, sessionPayload(params.sessionId))
    }
    case 'session/set_mode':
      modes.set(params.sessionId, params.modeId)
      return respond(id, {})
    case 'session/set_model':
      models.set(params.sessionId, params.modelId)
      return respond(id, {})
    case 'session/set_config_option':
      models.set(params.sessionId, params.value)
      return respond(id, { configOptions: sessionPayload(params.sessionId).configOptions ?? [] })
    case 'session/prompt': {
      if (!known.has(params?.sessionId)) return fail(id, -32602, 'sesión desconocida')
      const text = (params.prompt ?? []).map((b) => b.text ?? '').join('')
      void runPrompt(id, params.sessionId, text)
      return
    }
    default:
      return fail(id, -32601, `método no encontrado: ${method}`)
  }
}

createInterface({ input: process.stdin }).on('line', (text) => {
  note({ in: text })
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }
  if (msg.method === undefined) {
    const resolve = waiting.get(msg.id)
    if (resolve !== undefined) {
      waiting.delete(msg.id)
      resolve(msg.error ? { error: msg.error } : msg.result)
    }
    return
  }
  if (msg.id === undefined) {
    if (msg.method === 'session/cancel' && current !== undefined) {
      current.cancelled = true
      current.resolveCancel?.()
    }
    return
  }
  onRequest(msg)
})
process.stdin.on('end', () => process.exit(0))
