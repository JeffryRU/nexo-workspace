import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiscoveryError, discoverDaemon } from './discovery.ts'
import { StateFixture, TOKEN } from './test-helpers.ts'

let fx: StateFixture
beforeEach(async () => {
  fx = await StateFixture.create()
})
afterEach(() => fx.cleanup())

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DiscoveryError) return error.code
    throw error
  }
  return 'OK'
}

const found = () => discoverDaemon({ stateDir: fx.dir })

describe('daemon.json hostil', () => {
  it('rechaza puertos fuera de rango, no enteros o de otro tipo', async () => {
    const port = await fx.health()
    for (const bad of [0, -1, 65536, 1e9, 1.5, '4317', null, Number.NaN, [4317]]) {
      await fx.write(port, { port: bad })
      expect(await code(found()), JSON.stringify(bad)).toBe('CORRUPT')
    }
    await writeFile(
      join(fx.dir, 'daemon.json'),
      `{"version":"0","port":${port}0000000,"pid":1,"startedAt":"x"}`,
    )
    expect(await code(found())).toBe('CORRUPT')
  })

  it('rechaza un host no loopback y cualquier campo extra', async () => {
    const port = await fx.health()
    for (const extra of [
      { host: 'evil.example.com' },
      { host: '10.0.0.5' },
      { host: '127.0.0.1' },
      { url: 'ws://evil.example.com:80/' },
      { __proto__x: 1, extra: true },
    ]) {
      await fx.write(port, extra)
      expect(await code(found()), JSON.stringify(extra)).toBe('CORRUPT')
    }
  })

  it('nunca conecta a otro host aunque el archivo lo pida: la url sale siempre de 127.0.0.1', async () => {
    const port = await fx.health()
    await fx.write(port)
    expect((await found()).url).toBe(`ws://127.0.0.1:${port}/`)
  })

  it('rechaza campos con tipos o tamaños hostiles', async () => {
    const port = await fx.health()
    for (const extra of [
      { version: '' },
      { version: 'v'.repeat(65) },
      { pid: 0 },
      { pid: -3 },
      { pid: 1.5 },
      { startedAt: 'x'.repeat(41) },
      { version: 1 },
    ]) {
      await fx.write(port, extra)
      expect(await code(found()), JSON.stringify(extra)).toBe('CORRUPT')
    }
  })

  it('rechaza JSON que no es un objeto', async () => {
    for (const text of ['[]', 'null', '1', '"x"', 'true', '', '\u0000', '{"a":']) {
      await writeFile(join(fx.dir, 'daemon.json'), text)
      expect(await code(found()), text).toBe('CORRUPT')
    }
  })

  it('rechaza un archivo gigante sin leerlo entero', async () => {
    await writeFile(join(fx.dir, 'daemon.json'), `{"version":"${'a'.repeat(50 * 1024 * 1024)}"}`)
    expect(await code(found())).toBe('CORRUPT')
  })

  it('rechaza enlaces simbólicos (daemon.json y token)', async () => {
    const port = await fx.health()
    await fx.write(port)
    const real = join(fx.dir, 'real.json')
    await writeFile(real, JSON.stringify({ version: '0', port, pid: 1, startedAt: 'x' }))
    await rm(join(fx.dir, 'daemon.json'))
    try {
      await symlink(real, join(fx.dir, 'daemon.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return // Windows sin privilegio
      throw error
    }
    expect(await code(found())).toBe('CORRUPT')
    await rm(join(fx.dir, 'daemon.json'))
    await fx.write(port)
    await writeFile(join(fx.dir, 'real-token'), TOKEN)
    await rm(join(fx.dir, 'token'))
    await symlink(join(fx.dir, 'real-token'), join(fx.dir, 'token'))
    expect(await code(found())).toBe('CORRUPT')
  })

  it('el directorio de estado puede ser un archivo', async () => {
    const file = join(fx.dir, 'plano')
    await writeFile(file, 'x')
    expect(await code(discoverDaemon({ stateDir: file }))).toMatch(/NOT_RUNNING|CORRUPT/)
  })
})

describe('token hostil', () => {
  it('rechaza saltos de línea intermedios, espacios, nulos, cabeceras y longitudes extremas', async () => {
    const port = await fx.health()
    const bad = [
      `${TOKEN}\nX-Injected: 1`,
      `${TOKEN}\r\nSet-Cookie: a=b`,
      `${TOKEN} otro`,
      `${TOKEN}\u0000`,
      'a'.repeat(15),
      'a'.repeat(513),
      `nexo.token.${TOKEN},evil`,
      'ñ'.repeat(30),
      '',
    ]
    for (const token of bad) {
      await fx.write(port)
      await writeFile(join(fx.dir, 'token'), token)
      expect(await code(found()), JSON.stringify(token.slice(0, 30))).toBe('CORRUPT')
    }
  })

  it('un token gigante se rechaza sin leerlo entero', async () => {
    const port = await fx.health()
    await fx.write(port)
    await writeFile(join(fx.dir, 'token'), 'a'.repeat(10 * 1024 * 1024))
    expect(await code(found())).toBe('CORRUPT')
  })

  it('tolera saltos de línea y espacios solo al final o al principio', async () => {
    const port = await fx.health()
    await fx.write(port)
    await writeFile(join(fx.dir, 'token'), `\r\n${TOKEN}\r\n`)
    expect((await found()).token).toBe(TOKEN)
  })
})

describe('/health hostil', () => {
  it('una respuesta enorme o sin fin no se acepta ni se lee entera', async () => {
    const big = await fx.health({ body: `{"ok":true,"pad":"${'a'.repeat(100_000)}"}` })
    await fx.write(big)
    expect(await code(found())).toBe('STALE')
  })

  it('un servidor que no responde agota el tiempo y se considera STALE', async () => {
    const server = createServer(() => {})
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      await fx.write((server.address() as AddressInfo).port)
      expect(await code(discoverDaemon({ stateDir: fx.dir, healthTimeoutMs: 150 }))).toBe('STALE')
    } finally {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })

  it('una redirección a otro host no se sigue', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://example.invalid/health', 'x-nexo-daemon': '1' })
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      await fx.write((server.address() as AddressInfo).port)
      expect(await code(found())).toBe('STALE')
    } finally {
      await new Promise((r) => server.close(r))
    }
  })

  it('cuerpo que no es JSON, sin cabecera o con ok falso es STALE', async () => {
    for (const options of [
      { body: 'hola' },
      { body: '[]' },
      { body: 'null' },
      { header: '0' },
      { header: null },
      { body: '{"ok":"true"}' },
    ]) {
      await fx.write(await fx.health(options))
      expect(await code(found()), JSON.stringify(options)).toBe('STALE')
    }
  })
})

describe('directorio de estado', () => {
  it('rutas con caracteres raros no rompen el descubrimiento', async () => {
    const dir = join(fx.dir, 'con espacios y ñ')
    await mkdir(dir)
    expect(await code(discoverDaemon({ stateDir: dir }))).toBe('NOT_RUNNING')
  })
})
