import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentActionOutput,
  AgentAttachLine,
  AgentLsOutput,
  AgentNewOutput,
  AgentSendOutput,
} from './schemas.ts'
import { Sandbox, waitUntil } from './test-helpers.ts'

let sandbox: Sandbox | undefined
afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = undefined
})

const FAKE = { NEXO_AGENT_PROVIDERS: 'fake' }

async function attachText(sb: Sandbox, id: string, needle: string): Promise<string> {
  return waitUntil(async () => {
    const r = await sb.nexo(['agent', 'attach', id, '--no-follow'])
    return r.stdout.includes(needle) ? r.stdout : undefined
  })
}

describe('nexo agent contra el daemon real (proveedor falso)', () => {
  it('conversación, permiso desde otro proceso, interrupción y cierre', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon(FAKE)

    const created = AgentNewOutput.parse(
      await sb.json(['agent', 'new', '--provider', 'fake', '--cwd', tmpdir(), '--name', 'agente']),
    )
    const id = created.sessionId
    const ls = AgentLsOutput.parse(await sb.json(['agent', 'ls']))
    expect(ls.sessions.map((s) => s.id)).toEqual([id])
    expect((await sb.nexo(['agent', 'ls'])).stdout).toContain(id)
    // el árbol muestra el panel de agente como único panel de la pestaña
    const tree = await sb.nexo(['ls'])
    expect(tree.stdout).toContain('agent')

    const sent = AgentSendOutput.parse(
      await sb.json(['agent', 'send', id.slice(0, 14), 'hola', 'mundo']),
    )
    expect(sent.turn).toBe(1)
    const doc = await attachText(sb, id, 'fin del turno')
    expect(doc).toContain('> hola mundo')
    expect(doc).toContain('Eco: hola mundo')

    const lines = (await sb.nexo(['agent', 'attach', id, '--no-follow', '--json'])).stdout
      .trim()
      .split('\n')
      .map((l) => AgentAttachLine.parse(JSON.parse(l)))
    expect(lines.map((l) => l.event === 'block' && l.block.type)).toEqual(['user', 'text', 'usage'])

    // permiso: lo resuelve otro proceso con `agent respond`
    await sb.json(['agent', 'send', id, 'permiso'])
    await attachText(sb, id, '? Permiso: Ejecutar ls')
    const responded = AgentActionOutput.parse(await sb.json(['agent', 'respond', id, '1']))
    expect(responded.action).toBe('respond')
    await attachText(sb, id, 'Permiso concedido')

    // pregunta
    await sb.json(['agent', 'send', id, 'pregunta'])
    await attachText(sb, id, '¿Qué prefieres?')
    expect((await sb.nexo(['agent', 'respond', id, 'B'])).code).toBe(0)
    await attachText(sb, id, 'Elegiste: B')

    // interrupción
    await sb.json(['agent', 'send', id, 'largo'])
    await attachText(sb, id, 'pensando')
    await sb.json(['agent', 'interrupt', id])
    await attachText(sb, id, 'fin del turno: interrupted')

    // errores con --json
    const bad = await sb.nexo(['agent', 'send', 'no-existe', '--json', 'hola'])
    expect(bad.code).toBe(2)
    expect(JSON.parse(bad.stderr).error.code).toBe('NOT_FOUND')

    expect((await sb.nexo(['agent', 'close', id])).code).toBe(0)
    expect(AgentLsOutput.parse(await sb.json(['agent', 'ls'])).sessions).toEqual([])
  })

  it('attach en vivo pide el permiso por teclado y termina al cerrar la sesión', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon(FAKE)
    const { sessionId: id } = AgentNewOutput.parse(
      await sb.json(['agent', 'new', '--provider', 'fake', '--cwd', tmpdir()]),
    )
    const child = sb.spawnNexo(['agent', 'attach', id], {}, 'pipe')
    let out = ''
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    const exited = new Promise<number | null>((r) => child.on('close', r))
    await sb.json(['agent', 'send', id, 'permiso'])
    await waitUntil(async () => out.includes('respuesta> '))
    child.stdin?.write('1\n')
    await waitUntil(async () => out.includes('Permiso concedido'))
    expect((await sb.nexo(['agent', 'close', id])).code).toBe(0)
    expect(await exited).toBe(0)
    expect(out).toContain('[la sesión se cerró]')
  })
})

describe('nexo agent con el proveedor Ollama (servidor HTTP falso)', () => {
  it('agent new --provider ollama, enviar y ver la respuesta', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }] }))
        return
      }
      const line = (o: unknown) => JSON.stringify(o) + String.fromCharCode(10)
      res.write(line({ message: { content: 'respuesta ' }, done: false }))
      res.end(line({ message: { content: 'de ollama' }, done: true }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const sb = await Sandbox.create()
    sandbox = sb
    try {
      await sb.startDaemon({ NEXO_AGENT_PROVIDERS: 'ollama', NEXO_OLLAMA_URL: url })
      const { sessionId: id } = AgentNewOutput.parse(
        await sb.json(['agent', 'new', '--provider', 'ollama', '--cwd', tmpdir()]),
      )
      await sb.json(['agent', 'send', id, 'hola'])
      const doc = await attachText(sb, id, 'respuesta de ollama')
      expect(doc).toContain('> hola')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('nexo agent con el proveedor Codex (proceso app-server falso)', () => {
  it('agent new --provider codex, conversación y aprobación respondida desde la CLI', async () => {
    const fakeCodex = fileURLToPath(
      new URL('../../../packages/adapters/provider-codex/test/fake-codex.mjs', import.meta.url),
    )
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon({ NEXO_AGENT_PROVIDERS: 'codex', NEXO_CODEX_EXECUTABLE: fakeCodex })
    const { sessionId: id } = AgentNewOutput.parse(
      await sb.json(['agent', 'new', '--provider', 'codex', '--cwd', tmpdir()]),
    )
    await sb.json(['agent', 'send', id, 'simple hola'])
    const doc = await attachText(sb, id, 'Hola mundo')
    expect(doc).toContain('> simple hola')

    await sb.json(['agent', 'send', id, 'permiso'])
    await attachText(sb, id, '? Permiso: Ejecutar: rm -rf build')
    expect((await sb.nexo(['agent', 'respond', id, '1'])).code).toBe(0)
    await attachText(sb, id, 'Hecho.')
  })
})

describe('nexo agent con un agente ACP (agente falso, declarado en NEXO_ACP_AGENTS)', () => {
  it('agent new --provider gemini, conversación y permiso respondido desde la CLI', async () => {
    const fakeAcp = fileURLToPath(
      new URL('../../../packages/adapters/provider-acp/test/fake-acp.mjs', import.meta.url),
    )
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon({
      NEXO_AGENT_PROVIDERS: 'gemini',
      NEXO_ACP_AGENTS: JSON.stringify([
        { id: 'gemini', name: 'Gemini', command: fakeAcp, args: ['--acp'] },
      ]),
    })
    const { sessionId: id } = AgentNewOutput.parse(
      await sb.json(['agent', 'new', '--provider', 'gemini', '--cwd', tmpdir()]),
    )
    await sb.json(['agent', 'send', id, 'simple hola'])
    const doc = await attachText(sb, id, 'Hola desde ACP.')
    expect(doc).toContain('> simple hola')

    await sb.json(['agent', 'send', id, 'permiso'])
    await attachText(sb, id, '? Permiso: Ejecutar: rm -rf build')
    expect((await sb.nexo(['agent', 'respond', id, '1'])).code).toBe(0)
    await attachText(sb, id, 'Hecho.')
  })
})
