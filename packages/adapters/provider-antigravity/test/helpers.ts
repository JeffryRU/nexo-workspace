import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderEvent } from '@nexo/contracts'
import type { AgentProviderSession } from '@nexo/core'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import {
  type AntigravityProviderOptions,
  createAntigravityProvider,
  type LogEntry,
} from '../src/index.ts'

export const FAKE = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url))

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function wait(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('tiempo agotado')
    await sleep(5)
  }
}

export type LogLine = { argv?: string[]; cwd?: string; in?: string }

/** Proveedor contra `fake-agy.mjs` y sesiones cerradas al terminar cada prueba. */
export function useFakeAgy() {
  const sessions: AgentProviderSession[] = []
  const logs: LogEntry[] = []
  let dir: string
  let logFile: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexo-agy-test-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => {})
    logs.length = 0
  })

  function provider(
    env: Record<string, string> = {},
    options: Partial<AntigravityProviderOptions> = {},
  ) {
    logFile = join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(logFile, '')
    return createAntigravityProvider({
      env: { ...process.env, FAKE_AGY_LOG: logFile, ...env },
      executable: FAKE,
      probeCacheMs: 0,
      log: (entry) => logs.push(entry),
      ...options,
    })
  }

  async function open(
    env: Record<string, string> = {},
    options: Partial<AntigravityProviderOptions> = {},
    openOptions: {
      model?: string
      effort?: string
      permissionMode?: 'ask' | 'accept-edits' | 'plan' | 'bypass'
      resume?: string
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

  /** Lo que el `agy` falso registró (argumentos y mensajes recibidos). */
  const readLog = (): LogLine[] =>
    readFileSync(logFile, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as LogLine)
  /** Argumentos de cada turno lanzado (sin las consultas `models`/`--version`). */
  const turnArgs = () =>
    readLog().flatMap((l) =>
      l.argv?.includes('--output-format') && l.argv[0] !== 'models' ? [l.argv] : [],
    )
  const messages = () =>
    readLog().flatMap((l) =>
      l.in === undefined ? [] : [JSON.parse(l.in) as Record<string, unknown>],
    )

  const turnEnds = (events: ProviderEvent[]) => events.filter((e) => e.type === 'turn-end')
  const textOf = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'block-delta' && e.field === 'text' ? [e.text] : [])).join('')
  const errors = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'error' ? [e.error] : []))

  return {
    open,
    provider,
    readLog,
    turnArgs,
    messages,
    turnEnds,
    textOf,
    errors,
    logs,
    dir: () => dir,
  }
}
