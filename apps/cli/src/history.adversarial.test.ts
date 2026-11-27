import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv } from './test-helpers.ts'

describe('nexo history: contenido hostil', () => {
  it('títulos, carpetas y proveedores con secuencias de escape se sanean al listar', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.list', () => ({
      projects: [
        {
          cwd: '/work/\u001b[31mmalo\u001b[0m',
          name: 'x',
          sessions: [
            {
              provider: 'claude',
              sessionId: 's1',
              title: 'a\u001b]0;pwned\u0007b\u001b[2J',
              updatedAt: 1,
              resumable: true,
              readable: true,
            },
          ],
        },
      ],
      nextCursor: null,
      providers: [{ provider: 'claude', status: 'error', reason: '\u001b[2Jfallo' }],
    }))
    expect(await runCli(['history', 'ls'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
    expect(env.cap.out).not.toContain('\u0007')
    expect(env.cap.out).toContain('malo')
  })

  it('la transcripción con órdenes y escapes se muestra como texto sin secuencias', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.read', () => ({
      provider: 'claude',
      sessionId: 'abc',
      blocks: [
        {
          index: 0,
          turn: 1,
          block: { type: 'user', text: 'borra todo \u001b[2J\u001b]0;x\u0007 ; rm -rf /' },
        },
        {
          index: 1,
          turn: 1,
          block: {
            type: 'action',
            kind: 'exec',
            status: 'ok',
            tool: 'Bash',
            title: 'x\u001b[31m',
            output: '\u001b[2Jsalida',
          },
        },
      ],
      nextCursor: null,
      total: 2,
      truncated: false,
    }))
    expect(await runCli(['history', 'show', 'claude', 'abc'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
    expect(env.cap.out).not.toContain('\u0007')
    expect(env.cap.out).toContain('rm -rf /')
  })

  it('un daemon que repite siempre el cursor no cuelga --all', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.list', () => ({
      projects: [
        {
          cwd: '/w',
          name: 'w',
          sessions: Array.from({ length: 100 }, (_, i) => ({
            provider: 'claude',
            sessionId: `s${i}`,
            updatedAt: 1,
            resumable: true,
            readable: true,
          })),
        },
      ],
      nextCursor: 'siempre',
      providers: [],
    }))
    expect(await runCli(['history', '--json', 'ls', '--all'], env.deps)).toBe(0)
    expect(env.client.callsTo('history.list').length).toBeLessThanOrEqual(25)
  })

  it('un error del daemon sale con código de salida, sin trazas', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.read', () => {
      throw new Error('boom')
    })
    expect(await runCli(['history', 'show', 'claude', 'abc'], env.deps)).not.toBe(0)
  })
})
