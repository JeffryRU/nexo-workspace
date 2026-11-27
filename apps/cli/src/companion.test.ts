import type { MethodResult } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import {
  CompanionGetOutput,
  CompanionListOutput,
  CompanionSelectOutput,
  CompanionStateOutput,
} from './schemas.ts'
import { makeEnv } from './test-helpers.ts'

const list = (): MethodResult<'companion.list'> => ({
  companions: [
    { id: 'tiny', name: 'Tiny', version: '1.0.0', license: 'CC0-1.0', author: 'Nexo' },
    { id: 'otro', name: 'Otro', version: '2.0.0', license: 'MIT', author: 'Alguien' },
  ],
  invalid: [{ id: 'roto', reason: 'manifiesto no válido (id)' }],
  selected: 'tiny',
})

const detail = (): MethodResult<'companion.get'> => ({
  companion: {
    manifest: {
      format: 1,
      id: 'tiny',
      name: 'Tiny',
      version: '1.0.0',
      description: 'Paquete de prueba',
      author: { name: 'Nexo' },
      license: 'CC0-1.0',
      states: {
        idle: { src: 'idle.png' },
        waiting: { src: 's.png', sheet: { frameWidth: 1, frameHeight: 1, frames: 4, fps: 4 } },
      },
    },
    assets: [
      { path: 'idle.png', mime: 'image/png', bytes: 70 },
      { path: 's.png', mime: 'image/png', bytes: 80 },
    ],
    totalBytes: 150,
  },
})

describe('nexo companion', () => {
  it('list muestra el elegido, los paquetes y los no válidos', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.list', () => list())
    expect(await runCli(['companion', 'list'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('elegida: tiny')
    expect(env.cap.out).toContain('* tiny  Tiny 1.0.0 · Nexo · CC0-1.0')
    expect(env.cap.out).toContain('  otro  Otro 2.0.0')
    expect(env.cap.out).toContain('! roto  no válido: manifiesto no válido (id)')
  })

  it('list sin nada dice que no hay mascota ni paquetes', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.list', () => ({
      companions: [],
      invalid: [],
      selected: null,
    }))
    expect(await runCli(['companion', 'list'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('sin mascota')
    expect(env.cap.out).toContain('no hay paquetes')
  })

  it('--json: la salida cumple su esquema, también con la opción antes del subcomando', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.list', () => list())
    expect(await runCli(['companion', '--json', 'list'], env.deps)).toBe(0)
    expect(CompanionListOutput.safeParse(JSON.parse(env.cap.out)).success).toBe(true)
  })

  it('get describe el paquete', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.get', () => detail())
    expect(await runCli(['companion', 'get', 'tiny'], env.deps)).toBe(0)
    expect(env.client.callsTo('companion.get')[0]).toEqual({ id: 'tiny' })
    expect(env.cap.out).toContain('Tiny (tiny) 1.0.0')
    expect(env.cap.out).toContain('licencia: CC0-1.0')
    expect(env.cap.out).toContain('waiting: s.png (hoja de 4 cuadros)')
    expect(env.cap.out).toContain('2 recursos, 150 bytes')
    const json = makeEnv()
    json.client.handlers.set('companion.get', () => detail())
    expect(await runCli(['companion', 'get', 'tiny', '--json'], json.deps)).toBe(0)
    expect(CompanionGetOutput.safeParse(JSON.parse(json.cap.out)).success).toBe(true)
  })

  it('select y none llaman a companion.select', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.select', (p) => ({
      selected: (p as { id: string | null }).id,
    }))
    expect(await runCli(['companion', 'select', 'tiny'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('compañero elegido: tiny')
    expect(await runCli(['companion', 'none'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('sin mascota')
    expect(env.client.callsTo('companion.select')).toEqual([{ id: 'tiny' }, { id: null }])
    const json = makeEnv()
    json.client.handlers.set('companion.select', () => ({ selected: null }))
    expect(await runCli(['companion', 'none', '--json'], json.deps)).toBe(0)
    expect(CompanionSelectOutput.safeParse(JSON.parse(json.cap.out)).success).toBe(true)
  })

  it('state muestra el estado, desde cuándo y el compañero', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.state', () => ({
      state: 'busy',
      since: 1_700_000_000_000,
      selected: 'tiny',
    }))
    expect(await runCli(['companion', 'state'], env.deps)).toBe(0)
    expect(env.cap.out).toContain('busy desde 2023-11-14 22:13:20 UTC · compañero: tiny')
    const json = makeEnv()
    json.client.handlers.set('companion.state', () => ({ state: 'idle', since: 1, selected: null }))
    expect(await runCli(['companion', 'state', '--json'], json.deps)).toBe(0)
    expect(CompanionStateOutput.safeParse(JSON.parse(json.cap.out)).success).toBe(true)
  })

  it('errores de uso: sin subcomando, subcomando desconocido, argumentos de más o de menos', async () => {
    for (const args of [
      ['companion'],
      ['companion', 'borrar'],
      ['companion', 'list', 'x'],
      ['companion', 'get'],
      ['companion', 'select'],
      ['companion', 'select', 'a', 'b'],
      ['companion', 'none', 'x'],
      ['companion', 'state', 'x'],
    ]) {
      const env = makeEnv()
      expect(await runCli(args, env.deps), args.join(' ')).toBe(1)
      expect(env.cap.err).toContain('uso:')
    }
  })

  it('un error del daemon sale con su mensaje', async () => {
    const env = makeEnv()
    env.client.handlers.set('companion.select', () => {
      throw Object.assign(new Error('no existe ese compañero'), { code: 'NOT_FOUND' })
    })
    expect(await runCli(['companion', 'select', 'nada'], env.deps)).not.toBe(0)
  })
})
