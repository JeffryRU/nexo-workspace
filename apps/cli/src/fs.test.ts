import { resolve } from 'node:path'
import type { MethodParams, MethodResult } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { FsCatOutput, FsStatOutput } from './schemas.ts'
import { makeEnv, type TestEnv, WORK } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

const stat = (over: Partial<MethodResult<'fs.stat'>> = {}): MethodResult<'fs.stat'> => ({
  path: resolve(WORK, 'LEEME.md'),
  kind: 'file',
  size: 12,
  mtimeMs: 1_700_000_000_000,
  type: 'markdown',
  mime: 'text/markdown',
  maxBytes: 8 * 1024 * 1024,
  tooLarge: false,
  ...over,
})

const chunk = (over: Partial<MethodResult<'fs.read'>> = {}): MethodResult<'fs.read'> => ({
  path: resolve(WORK, 'LEEME.md'),
  size: 5,
  mtimeMs: 7,
  type: 'markdown',
  mime: 'text/markdown',
  offset: 0,
  length: 5,
  encoding: 'utf8',
  data: 'hola\n',
  eof: true,
  ...over,
})

describe('nexo fs stat', () => {
  it('resuelve la ruta relativa contra la carpeta actual y describe el archivo', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.stat', () => stat())
    expect(await run(env, 'fs', 'stat', 'LEEME.md')).toBe(0)
    expect(env.client.callsTo('fs.stat')[0]).toEqual({ path: resolve(WORK, 'LEEME.md') })
    expect(env.cap.out).toContain('archivo, 12 bytes')
    expect(env.cap.out).toContain('tipo markdown (text/markdown)')
  })

  it('una carpeta no trae tipo y un archivo demasiado grande se avisa', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.stat', () => ({
      path: WORK,
      kind: 'directory',
      size: 0,
      mtimeMs: 1,
    }))
    expect(await run(env, 'fs', 'stat', '.')).toBe(0)
    expect(env.cap.out).toContain('carpeta')
    expect(env.cap.out).not.toContain('tipo ')
    const big = makeEnv()
    big.client.handlers.set('fs.stat', () => stat({ tooLarge: true }))
    await run(big, 'fs', 'stat', 'x')
    expect(big.cap.out).toContain('SUPERADO')
  })

  it('--json emite el resultado validado', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.stat', () => stat())
    expect(await run(env, 'fs', '--json', 'stat', '/abs/x.md')).toBe(0)
    expect(FsStatOutput.parse(JSON.parse(env.cap.out)).type).toBe('markdown')
    expect(env.client.callsTo('fs.stat')[0]).toEqual({ path: resolve('/abs/x.md') })
  })
})

describe('nexo fs cat', () => {
  it('lee un texto por trozos hasta el final', async () => {
    const env = makeEnv()
    const pages = [
      chunk({ data: 'hola ', length: 5, size: 10, eof: false }),
      chunk({ data: 'mundo', offset: 5, length: 5, size: 10, eof: true }),
    ]
    env.client.handlers.set('fs.read', () => pages.shift())
    expect(await run(env, 'fs', 'cat', 'LEEME.md')).toBe(0)
    expect(env.cap.out).toBe('hola mundo\n')
    const calls = env.client.callsTo('fs.read') as MethodParams<'fs.read'>[]
    expect(calls[1]).toMatchObject({ offset: 5, expectMtimeMs: 7 })
  })

  it('un binario pide --base64 y con él se concatena bien aunque los trozos no sean múltiplos de 3', async () => {
    const png = chunk({
      type: 'png',
      mime: 'image/png',
      encoding: 'base64',
      data: 'AQI=',
      length: 2,
      size: 5,
      eof: false,
    })
    const refuse = makeEnv()
    refuse.client.handlers.set('fs.read', () => png)
    expect(await run(refuse, 'fs', 'cat', 'a.png')).toBe(1)
    expect(refuse.cap.err).toContain('--base64')

    const env = makeEnv()
    const pages = [png, { ...png, offset: 2, length: 3, data: 'AwQF', eof: true }]
    env.client.handlers.set('fs.read', () => pages.shift())
    expect(await run(env, 'fs', 'cat', '--base64', 'a.png')).toBe(0)
    expect(Buffer.from(env.cap.out.trim(), 'base64')).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect((env.client.callsTo('fs.read')[0] as { encoding: string }).encoding).toBe('base64')
  })

  it('--max-bytes recorta y lo avisa; --json lo marca', async () => {
    const page = () => chunk({ data: 'abc', length: 3, size: 100, eof: false })
    const env = makeEnv()
    env.client.handlers.set('fs.read', page)
    expect(await run(env, 'fs', 'cat', '--max-bytes', '3', 'x.txt')).toBe(0)
    expect(env.cap.out).toContain('recortado a 3 bytes de 100')
    expect((env.client.callsTo('fs.read')[0] as { length: number }).length).toBe(3)
    const j = makeEnv()
    j.client.handlers.set('fs.read', page)
    await run(j, 'fs', 'cat', '--json', '--max-bytes', '3', 'x.txt')
    expect(FsCatOutput.parse(JSON.parse(j.cap.out))).toMatchObject({
      truncated: true,
      bytes: 3,
      data: 'abc',
    })
  })

  it('un archivo vacío termina sin bucle', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.read', () => chunk({ data: '', length: 0, size: 0, eof: true }))
    expect(await run(env, 'fs', 'cat', 'vacio.txt')).toBe(0)
  })
})

describe('nexo fs: uso', () => {
  it('sin subcomando o con uno desconocido es un error de uso', async () => {
    const cases = [
      ['fs'],
      ['fs', 'rm', 'x'],
      ['fs', 'stat'],
      ['fs', 'cat', 'a', 'b'],
      ['fs', 'cat', '--max-bytes', '0', 'a'],
    ]
    for (const args of cases) {
      const env = makeEnv()
      expect(await run(env, ...args), args.join(' ')).toBe(1)
    }
  })

  it('un error del daemon no es un éxito', async () => {
    const env = makeEnv()
    env.client.handlers.set('fs.read', () => {
      throw new Error('boom')
    })
    expect(await run(env, 'fs', 'cat', '/etc/passwd')).not.toBe(0)
    expect(env.cap.err).toContain('nexo:')
  })
})
