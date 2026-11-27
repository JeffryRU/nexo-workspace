import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { NexoClient } from '@nexo/client'
import { connectToDaemon, discoverDaemon } from '@nexo/client/node'

const parsedScale = Number(process.env.NEXO_TEST_TIMEOUT_SCALE ?? '1')
export const TIMEOUT_SCALE =
  Number.isFinite(parsedScale) && parsedScale >= 1 ? Math.min(parsedScale, 20) : 1

export const MCP_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
export const DAEMON_MAIN = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))

export async function waitUntil<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 20_000 * TIMEOUT_SCALE,
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > end) throw new Error('tiempo agotado esperando una condición')
    await new Promise((r) => setTimeout(r, 50))
  }
}

export type McpSession = {
  client: Client
  stderr: () => string
  updates: string[]
  close(): Promise<void>
}

/** Daemon real (proceso hijo, proveedores falsos) en un directorio de estado temporal y clientes MCP reales. */
export class Sandbox {
  readonly dir: string
  readonly children: ChildProcess[] = []
  readonly sessions: McpSession[] = []
  readonly directClients: NexoClient[] = []

  private constructor(dir: string) {
    this.dir = dir
  }

  static async create(): Promise<Sandbox> {
    return new Sandbox(await mkdtemp(join(tmpdir(), 'nexo-mcp-int-')))
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v
    return {
      ...base,
      NEXO_STATE_DIR: this.dir,
      NEXO_PORT: '0',
      NEXO_LOG_LEVEL: 'error',
      NEXO_AGENT_PROVIDERS: 'fake',
      ...extra,
    }
  }

  async startDaemon(extra: Record<string, string> = {}): Promise<ChildProcess> {
    const child = spawn(process.execPath, [DAEMON_MAIN], {
      env: this.env(extra),
      stdio: 'ignore',
      windowsHide: true,
    })
    this.children.push(child)
    await this.waitDaemon()
    return child
  }

  async waitDaemon(timeoutMs = 20_000 * TIMEOUT_SCALE): Promise<void> {
    await waitUntil(async () => {
      try {
        return await discoverDaemon({ stateDir: this.dir })
      } catch {
        return false
      }
    }, timeoutMs)
  }

  async token(): Promise<string> {
    return (await readFile(join(this.dir, 'token'), 'utf8')).trim()
  }

  /** Cliente directo del daemon (para preparar escenarios: crear espacios, terminales...). */
  async direct(): Promise<NexoClient> {
    const client = await connectToDaemon({
      discovery: { stateDir: this.dir },
      client: { reconnect: false },
    })
    this.directClients.push(client)
    return client
  }

  /** Servidor MCP real como proceso hijo y un `Client` del SDK hablándole por stdio. */
  async mcp(extraEnv: Record<string, string> = {}): Promise<McpSession> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_MAIN],
      env: this.env(extraEnv),
      stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    const client = new Client({ name: 'prueba-integracion', version: '0.0.0' })
    const updates: string[] = []
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri)
    })
    await client.connect(transport)
    const session: McpSession = {
      client,
      stderr: () => stderr,
      updates,
      close: async () => {
        await client.close()
      },
    }
    this.sessions.push(session)
    return session
  }

  async cleanup(): Promise<void> {
    for (const s of this.sessions) await s.close().catch(() => {})
    for (const c of this.directClients) c.close()
    try {
      const raw = await readFile(join(this.dir, 'daemon.json'), 'utf8')
      const pid = (JSON.parse(raw) as { pid?: number }).pid
      if (pid !== undefined) process.kill(pid)
    } catch {
      // ya no hay daemon
    }
    for (const child of this.children) if (child.exitCode === null) child.kill()
    await new Promise((r) => setTimeout(r, 200))
    await rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

export type ToolText = { error: boolean; text: string; structured?: Record<string, unknown> }

export async function call(
  session: McpSession,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolText> {
  try {
    const r = await session.client.callTool({ name, arguments: args })
    const content = (r.content ?? []) as { type: string; text?: string }[]
    return {
      error: r.isError === true,
      text: content.map((c) => c.text ?? '').join('\n'),
      ...(r.structuredContent === undefined
        ? {}
        : { structured: r.structuredContent as Record<string, unknown> }),
    }
  } catch (error) {
    return { error: true, text: error instanceof Error ? error.message : String(error) }
  }
}

/** Script de `node -e` para las terminales de prueba: imprime LISTO y repite lo que recibe. */
export const ECHO_SCRIPT =
  "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('eco:'+JSON.stringify(d)+'\\n'));console.log('LISTO');setInterval(()=>{},1000)"
