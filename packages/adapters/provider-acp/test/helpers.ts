import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderEvent } from '@nexo/contracts'
import type { AgentProviderSession } from '@nexo/core'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import {
  type AcpAgentConfig,
  type AcpProviderOptions,
  createAcpProvider,
  type LogEntry,
} from '../src/index.ts'

export const FAKE = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))

export const AGENT: AcpAgentConfig = {
  id: 'fake-acp',
  name: 'ACP Falso',
  command: FAKE,
  args: ['--acp'],
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function wait(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('tiempo agotado')
    await sleep(5)
  }
}

export type LogLine = {
  argv?: string[]
  in?: string
  lateReply?: unknown
  permissionReply?: unknown
  sessionNew?: Record<string, unknown>
  sessionLoad?: Record<string, unknown>
}

/** Proveedor contra `fake-acp.mjs` y sesiones cerradas al terminar cada prueba. */
export function useFakeAcp() {
  const sessions: AgentProviderSession[] = []
  const logs: LogEntry[] = []
  let dir: string
  let logFile: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexo-acp-test-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => {})
    logs.length = 0
  })

  function provider(
    env: Record<string, string> = {},
    options: Partial<AcpProviderOptions> = {},
    agent: Partial<AcpAgentConfig> = {},
  ) {
    logFile = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(logFile, '')
    return createAcpProvider({
      agent: { ...AGENT, ...agent },
      env: { ...process.env, FAKE_ACP_LOG: logFile, ...env },
      probeCacheMs: 0,
      log: (entry) => logs.push(entry),
      ...options,
    })
  }

  async function open(
    env: Record<string, string> = {},
    options: Partial<AcpProviderOptions> = {},
    openOptions: {
      model?: string
      permissionMode?: 'ask' | 'accept-edits' | 'plan' | 'bypass'
      resume?: string
      memory?: string
    } = {},
  ) {
    const p = provider(env, options)
    const session = await p.open({ cwd: dir, ...openOptions })
    sessions.push(session)
    const events: ProviderEvent[] = []
    session.onEvent((e) => {
      // Todo evento que sale del adaptador debe cumplir el contrato.
      expect(ProviderEvent.safeParse(e).success, JSON.stringify(e).slice(0, 300)).toBe(true)
      events.push(e)
    })
    return { provider: p, session, events }
  }

  /** Lo que el agente falso registró (líneas recibidas y argumentos). */
  const readLog = (): LogLine[] =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as LogLine)
  /** Mensajes JSON-RPC que el cliente envió, ya analizados. */
  const received = () =>
    readLog().flatMap((l) =>
      l.in === undefined ? [] : [JSON.parse(l.in) as Record<string, unknown>],
    )
  const calls = (method: string) => received().filter((m) => m.method === method)

  const turnEnds = (events: ProviderEvent[]) => events.filter((e) => e.type === 'turn-end')
  const textOf = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'block-delta' && e.field === 'text' ? [e.text] : [])).join('')
  const errors = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'error' ? [e.error] : []))

  return {
    open,
    provider,
    readLog,
    received,
    calls,
    turnEnds,
    textOf,
    errors,
    logs,
    dir: () => dir,
  }
}
