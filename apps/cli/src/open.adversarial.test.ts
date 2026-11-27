import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv, sampleWorkspaces } from './test-helpers.ts'

describe('nexo open adversarial', () => {
  it('una ruta vacía o con byte nulo se rechaza sin llamar al daemon', async () => {
    for (const bad of ['', 'a\u0000b']) {
      const env = makeEnv()
      env.client.workspaces = sampleWorkspaces()
      expect(await runCli(['open', bad], env.deps)).toBe(1)
      expect(env.client.calls).toHaveLength(0)
    }
  })

  it('el daemon que rechaza la ruta (FORBIDDEN, .ssh) corta antes de tocar paneles', async () => {
    const env = makeEnv()
    env.client.workspaces = sampleWorkspaces()
    env.client.handlers.set('fs.stat', () => {
      throw Object.assign(new Error('ruta protegida'), { code: 'FORBIDDEN' })
    })
    expect(await runCli(['open', '/home/x/.ssh/id_rsa'], env.deps)).not.toBe(0)
    expect(env.client.callsTo('pane.split')).toHaveLength(0)
    expect(env.client.callsTo('viewer.open')).toHaveLength(0)
  })

  it('un --pane con una referencia absurda no llega a ningún panel', async () => {
    const env = makeEnv()
    env.client.workspaces = sampleWorkspaces()
    env.client.handlers.set('fs.stat', () => ({
      path: '/x',
      kind: 'file',
      size: 1,
      mtimeMs: 1,
      type: 'text',
      mime: 'text/plain',
      maxBytes: 10,
      tooLarge: false,
    }))
    expect(await runCli(['open', '/x', '--pane', 'x'.repeat(5000)], env.deps)).toBe(1)
    expect(env.client.callsTo('pane.split')).toHaveLength(0)
  })
})
