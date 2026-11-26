import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { makeEnv } from './test-helpers.ts'

const base = {
  path: '/work/x.txt',
  size: 40,
  mtimeMs: 1,
  type: 'text',
  mime: 'text/plain',
  offset: 0,
  length: 40,
  encoding: 'utf8',
  eof: true,
}

describe('nexo fs cat adversarial', () => {
  it('el contenido con secuencias de escape no llega crudo al terminal', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.read', () => ({
      ...base,
      data: 'hola \u001b]0;pwned\u0007\u001b[2J\u001b[31mrojo\u001b[0m fin\n',
    }))
    expect(await runCli(['fs', 'cat', 'x.txt'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
    expect(env.cap.out).not.toContain('\u0007')
    expect(env.cap.out).toContain('rojo')
  })

  it('un daemon que devuelve un trozo vacío sin eof no cuelga la CLI', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.read', () => ({ ...base, data: '', length: 0, eof: false }))
    expect(await runCli(['fs', 'cat', 'x.txt'], env.deps)).toBe(0)
    expect(env.client.callsTo('fs.read')).toHaveLength(1)
  })

  it('una ruta con byte nulo o vacía se rechaza sin llamar al daemon', async () => {
    for (const bad of ['', 'a\u0000b']) {
      const env = makeEnv()
      expect(await runCli(['fs', 'stat', bad], env.deps)).toBe(1)
      expect(env.client.callsTo('fs.stat')).toHaveLength(0)
    }
  })

  it('un nombre de archivo con escapes se sanea al mostrar el stat', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.stat', () => ({
      path: '/work/\u001b[31mmalo\u001b[0m.txt',
      kind: 'file',
      size: 1,
      mtimeMs: 1,
    }))
    expect(await runCli(['fs', 'stat', '/work/x'], env.deps)).toBe(0)
    expect(env.cap.out).not.toContain('\u001b')
  })
})
