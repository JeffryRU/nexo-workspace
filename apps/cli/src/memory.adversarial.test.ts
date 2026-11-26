import type { Observation } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv, SESSION_ID, type TestEnv } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

const badChars = (s: string): string[] =>
  [...s].filter((ch) => {
    const c = ch.codePointAt(0) ?? 0
    return (
      (c < 0x20 && c !== 0x0a && c !== 0x09) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202e
    )
  })

const EVIL = 'ok\u001b[2J\u001b]0;pwn\u0007‮ fin\r\u0085línea\u0000'

const obs = (seq: number, text: string): Observation => ({
  seq,
  at: 1_700_000_000_000,
  priority: 'high',
  scope: 'project',
  sessionId: SESSION_ID as never,
  range: { from: 0, to: 1 },
  text,
})

describe('nexo memory: texto hostil del modelo no llega crudo a la terminal', () => {
  it('ls, search y status sanean observaciones, reflexión, resumidor y motivo de pausa', async () => {
    const env = makeEnv()
    env.client.handlers.set('memory.list', () => ({
      reflection: {
        generation: 1,
        createdAt: 1,
        coversThroughSeq: 0,
        text: `línea\n${EVIL}`,
        sources: [],
      },
      observations: [obs(1, EVIL)],
      nextSeq: null,
    }))
    env.client.handlers.set('memory.search', () => ({
      observations: [obs(1, EVIL)],
      truncated: false,
    }))
    env.client.handlers.set('memory.status', () => ({
      enabled: true,
      summarizer: EVIL,
      pausedReason: EVIL,
      thresholds: { observerBatchTokens: 6000, reflectorTokens: 40000 },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }))
    expect(await run(env, 'memory', 'ls')).toBe(0)
    expect(await run(env, 'memory', 'search', 'ok')).toBe(0)
    expect(await run(env, 'memory', 'status')).toBe(0)
    expect(badChars(env.cap.out)).toEqual([])
    expect(env.cap.out).toContain('\\x1b')
  })

  it('argumentos enormes o raros se rechazan sin llamar al daemon', async () => {
    const env = makeEnv()
    expect(await run(env, 'memory', 'recall', 'a'.repeat(5000), '1')).toBe(1)
    expect(
      await run(env, 'memory', 'search', ...Array.from({ length: 2000 }, () => 'palabra')),
    ).toBe(1)
    expect(await run(env, 'memory', 'ls', '--limit', '99999999999')).toBe(1)
    expect(env.client.callsTo('memory.search')).toHaveLength(0)
    expect(env.client.callsTo('memory.list')).toHaveLength(0)
  })
})
