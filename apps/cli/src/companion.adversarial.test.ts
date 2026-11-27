import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv } from './test-helpers.ts'

describe('nexo companion: contenido hostil', () => {
  it('nombres, autores, motivos e ids con secuencias de escape se sanean', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.list', () => ({
      companions: [
        {
          id: 'tiny',
          name: '\u001b[31mrojo\u001b[0m\u001b]0;pwned\u0007',
          version: '1.0.0',
          license: 'MIT',
          author: '\u001b[2Jautor',
        },
      ],
      invalid: [{ id: 'x\u001b[1m', reason: '\u001b[2Jmotivo\u0007' }],
      selected: null,
    }))
    expect(await runCli(['companion', 'list'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
    expect(env.cap.out).not.toContain('\u0007')
    expect(env.cap.out).toContain('rojo')
    expect(env.cap.out).toContain('motivo')
  })

  it('un id con forma rara se manda tal cual al daemon (que lo valida) y su error no escapa terminal', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.get', () => {
      throw Object.assign(new Error('\u001b[31mmalo'), { code: 'INVALID_PARAMS' })
    })
    expect(await runCli(['companion', 'get', '../../etc'], env.deps)).not.toBe(0)
    expect(env.cap.err).not.toContain('\u001b')
  })

  it('una salida del daemon que no cumple el esquema no se imprime como JSON válido', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.state', () => ({ state: 'dizzy', since: 'x' }))
    expect(await runCli(['companion', 'state', '--json'], env.deps)).not.toBe(0)
    expect(env.cap.out).toBe('')
  })
})
