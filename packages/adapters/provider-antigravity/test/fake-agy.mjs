#!/usr/bin/env node
// `agy` falso para las pruebas: imita lo que Nexo usa de la CLI real (`--version`, `models --output-format json`
// y un turno con `--output-format stream-json --input-format stream-json`). El escenario lo elige la primera
// palabra del mensaje. El formato sigue la documentación oficial de `agy` (headless); no es una captura real.
import { appendFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const log = (obj) => {
  if (process.env.FAKE_AGY_LOG) appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(obj)}\n`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CONV = process.env.FAKE_AGY_CONVERSATION ?? '11111111-2222-3333-4444-555555555555'
const out = (obj) => new Promise((r) => process.stdout.write(`${JSON.stringify(obj)}\n`, r))
const pace = () => sleep(Number(process.env.FAKE_AGY_DELAY_MS ?? 0))

log({ argv, cwd: process.cwd() })

if (argv[0] === '--version') {
  console.log('1.2.0')
  process.exit(0)
}
if (argv[0] === 'models') {
  if (process.env.FAKE_AGY_LOGGED_OUT === '1') {
    console.error('Error: not signed in. Run agy and sign in.')
    process.exit(1)
  }
  if (process.env.FAKE_AGY_MODELS_HANG === '1') await sleep(60000)
  if (process.env.FAKE_AGY_MODELS_BROKEN === '1') console.log('esto no es JSON')
  else {
    console.log(
      JSON.stringify({
        models: [
          { id: 'gemini-fake-pro', display_name: 'Gemini Fake Pro', default: true },
          { id: 'gemini-fake-flash' },
        ],
      }),
    )
  }
  process.exit(0)
}

const argAfter = (flag) => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const conversation = argAfter('--conversation') ?? CONV
const model = argAfter('--model')
const mode = argv.includes('--dangerously-skip-permissions')
  ? 'always-proceed'
  : (argAfter('--mode') ?? 'request-review')

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk
let content = ''
for (const l of input.split('\n')) {
  if (l.trim() === '') continue
  log({ in: l })
  try {
    const m = JSON.parse(l)
    content = typeof m.message?.content === 'string' ? m.message.content : ''
  } catch {
    content = ''
  }
}

const init = () =>
  out({
    event: 'init',
    conversation_id: conversation,
    init: {
      cwd: process.cwd(),
      tools: ['run_command', 'write_to_file'],
      permission_mode: mode,
      ...(model ? { model } : {}),
    },
  })
const step = (index, state, type, extra = {}) =>
  out({
    event: 'step_update',
    step_update: {
      conversation_id: conversation,
      step_index: index,
      state,
      step_type: type,
      ...extra,
    },
  })
const usage = {
  input_tokens: 120,
  output_tokens: 30,
  thinking_tokens: 12,
  cache_read_tokens: 80,
  total_tokens: 150,
}
const result = (status, response, extra = {}) =>
  out({
    event: 'result',
    result: {
      conversation_id: conversation,
      status,
      response,
      duration_seconds: 0.5,
      num_turns: 1,
      usage,
      ...extra,
    },
  })

const word = content.split(' ')[0]
await init()
await step(0, 'DONE', 'user_input')

switch (word) {
  case 'long': {
    await step(1, 'ACTIVE', 'agent_response', { text_delta: 'Trabajando...' })
    process.on('SIGINT', async () => {
      await result('INTERRUPTED', 'Trabajando...', { finished_reason: 'interrupted' })
      process.exit(130)
    })
    await sleep(120000)
    break
  }
  case 'tool': {
    await step(1, 'ACTIVE', 'tool', {
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hola' } },
    })
    await pace()
    await step(1, 'DONE', 'tool', {
      tool_name: 'run_command',
      duration_seconds: 0.07,
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'echo hola' },
        output: 'hola\r\n',
      },
    })
    const target = `${process.cwd().replace(/\\/g, '/')}/src/a.ts`
    await step(2, 'DONE', 'tool', {
      tool_name: 'write_to_file',
      tool_info: {
        name: 'write_to_file',
        parameters: { TargetFile: target, CodeContent: 'export const a = 1\n' },
        output: 'ok',
      },
    })
    await step(3, 'DONE', 'tool', {
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'rm -rf /' },
        error: { type: 'PERMISSION_DENIED', message: 'denegado por el modo de permisos' },
      },
    })
    await step(4, 'DONE', 'agent_response', { text_delta: 'Hecho: creé src/a.ts.', usage })
    await result('SUCCESS', 'Hecho: creé src/a.ts.')
    break
  }
  case 'done-full': {
    await step(1, 'ACTIVE', 'agent_response', { text_delta: 'Respuesta larga ' })
    await step(1, 'ACTIVE', 'agent_response', { text_delta: 'y completa.' })
    await step(1, 'DONE', 'agent_response', { text_delta: 'Respuesta larga y completa.', usage })
    await result('SUCCESS', 'Respuesta larga y completa.')
    break
  }
  case 'result-only':
    await result('SUCCESS', 'Solo en el resultado.')
    break
  case 'error':
    await result('ERROR', '', { error: { type: 'MODEL_ERROR', message: 'el modelo falló' } })
    process.exit(3)
    break
  case 'auth':
    await result('ERROR', '', { error: 'UNAUTHENTICATED (401): token expired' })
    process.exit(3)
    break
  case 'crash':
    console.error(
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","message":"You have exhausted your quota on this model."}',
    )
    process.exit(3)
    break
  case 'garbage':
    process.stdout.write(
      'esto no es json\n{"event":"raro","x":1}\n[1,2,3]\n{"event":"step_update"}\n',
    )
    await step(1, 'DONE', 'agent_response', { text_delta: 'Sobrevivió.' })
    await result('SUCCESS', 'Sobrevivió.')
    break
  case 'bigline':
    process.stdout.write(`${'x'.repeat(Number(process.env.FAKE_AGY_BIG ?? 2_000_000))}\n`)
    await step(1, 'DONE', 'agent_response', { text_delta: 'Tras la línea enorme.' })
    await result('SUCCESS', 'Tras la línea enorme.')
    break
  // Salida continua (para medir la interfaz con varios proveedores emitiendo a la vez).
  case 'stream': {
    const n = Number(process.env.FAKE_AGY_STREAM_N ?? 300)
    for (let i = 0; i < n; i++) {
      await step(1, 'ACTIVE', 'agent_response', { text_delta: 'palabra ' })
      await sleep(Number(process.env.FAKE_AGY_STREAM_MS ?? 10))
    }
    await step(1, 'DONE', 'agent_response', { usage })
    await result('SUCCESS', 'palabra '.repeat(n))
    break
  }
  case 'silent':
    await sleep(120000)
    break
  case 'permiso':
    // agy en modo -p no pide permisos: lo no preaprobado se deniega (la herramienta vuelve con error).
    await step(1, 'DONE', 'tool', {
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'npm publish' },
        error: { type: 'PERMISSION_DENIED', message: 'requiere permiso' },
      },
    })
    await step(2, 'DONE', 'agent_response', { text_delta: 'No tengo permiso.' })
    await result('SUCCESS', 'No tengo permiso.')
    break
  default: {
    const reply = word === 'echo' ? content.slice(5) : 'Hola desde agy'
    const mid = Math.ceil(reply.length / 2)
    await step(1, 'ACTIVE', 'agent_response', { text_delta: reply.slice(0, mid) })
    await pace()
    await step(1, 'ACTIVE', 'agent_response', { text_delta: reply.slice(mid) })
    await pace()
    await step(1, 'DONE', 'agent_response', { duration_seconds: 0.4, usage })
    await step(2, 'DONE', 'checkpoint', { usage })
    await result('SUCCESS', reply)
  }
}
