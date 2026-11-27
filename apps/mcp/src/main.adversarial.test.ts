import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_MAIN, TIMEOUT_SCALE } from './integration-helpers.ts'

type Run = { code: number | null; stdout: string; stderr: string }

/** Lanza `main.ts`, le manda `input` por stdin y espera a que termine (o lo mata al vencer el plazo). */
async function runMain(
  env: Record<string, string>,
  input: string,
  options: { closeWhen?: (stdout: string) => boolean } = {},
): Promise<Run> {
  const dir = await mkdtemp(join(tmpdir(), 'nexo-mcp-main-'))
  try {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
    const child = spawn(process.execPath, [MCP_MAIN], {
      env: { ...base, NEXO_STATE_DIR: dir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
      if (options.closeWhen?.(stdout) === true) child.stdin.end()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.stdin.on('error', () => {})
    const done = new Promise<number | null>((resolve) => child.on('close', resolve))
    child.stdin.write(input)
    if (options.closeWhen === undefined) child.stdin.end()
    const timer = setTimeout(() => child.kill(), 20_000 * TIMEOUT_SCALE)
    const code = await done
    clearTimeout(timer)
    return { code, stdout, stderr }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'x', version: '1' },
  },
})
const INITIALIZED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
const lines = (s: string) => s.split('\n').filter((l) => l.trim() !== '')

describe('main.ts (proceso real)', () => {
  it.each([
    ['NEXO_MCP_WRITE', 'quizás'],
    ['NEXO_MCP_MAX_WRITE_BYTES', '-1'],
    ['NEXO_MCP_WRITE_RATE', '0'],
    ['NEXO_MCP_ALLOW_PERMISSIONS', '1'],
  ])(
    'configuración inválida (%s=%s): sale con 2, avisa por stderr y no escribe en stdout',
    async (name, value) => {
      const r = await runMain({ [name]: value }, '')
      expect(r.code).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain(
        name === 'NEXO_MCP_ALLOW_PERMISSIONS' ? 'NEXO_MCP_ALLOW_PERMISSIONS' : name,
      )
    },
  )

  it('stdout solo lleva JSON-RPC: basura en stdin no lo contamina ni tumba al servidor', async () => {
    const huge = 'x'.repeat(200_000)
    const input = [
      'esto no es json',
      '{"jsonrpc":"2.0"',
      huge,
      '[]',
      'null',
      '{"jsonrpc":"2.0","id":99,"method":"no/existe"}',
      INIT,
      INITIALIZED,
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'workspaces_list', arguments: {} },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'terminal_write', arguments: { terminalId: 'x', data: 'y' } },
      }),
      '',
    ].join('\n')
    const r = await runMain({}, input, {
      // se cierra stdin solo cuando ya llegó la última respuesta esperada (sin plazos fijos)
      closeWhen: (out) => out.includes('"id":4'),
    })
    const messages = lines(r.stdout).map(
      (l) => JSON.parse(l) as { id?: number; result?: unknown; error?: { message: string } },
    )
    // todo lo que sale por stdout es un mensaje JSON-RPC válido
    for (const m of messages) expect(m).toHaveProperty('jsonrpc')
    const byId = new Map(messages.filter((m) => m.id !== undefined).map((m) => [m.id, m]))
    expect(byId.get(1)?.result).toBeDefined()
    const listed = byId.get(2)?.result as { tools: { name: string }[] } | undefined
    const toolNames = (listed?.tools ?? []).map((t) => t.name)
    expect(toolNames).toContain('workspaces_list')
    expect(toolNames).not.toContain('terminal_write')
    // sin daemon (directorio de estado vacío) la lectura responde con un error claro y no cuelga
    const list = byId.get(3)?.result as { isError?: boolean; content: { text: string }[] }
    expect(
      list,
      `stdout=${r.stdout.slice(0, 3000)} stderr=${r.stderr.slice(0, 1500)}`,
    ).toBeDefined()
    expect(list.isError).toBe(true)
    expect(list.content[0]?.text).toContain('DAEMON_UNAVAILABLE')
    // la escritura no registrada se rechaza
    expect(byId.get(4)?.error?.message ?? JSON.stringify(byId.get(4)?.result)).toMatch(
      /not found|isError/i,
    )
    expect(r.code).toBe(0)
  })

  it('termina cuando el cliente cierra stdin', async () => {
    const started = Date.now()
    const r = await runMain({}, `${INIT}\n${INITIALIZED}\n`)
    expect(r.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(15_000 * TIMEOUT_SCALE)
    expect(r.stderr).toContain('listo (escritura desactivada)')
  })
})
