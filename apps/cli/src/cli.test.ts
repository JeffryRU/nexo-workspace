import { DiscoveryError } from '@nexo/client/node'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { classifyError, EXIT } from './errors.ts'
import { ErrorOutput } from './schemas.ts'
import { clientError, makeEnv, sampleWorkspaces } from './test-helpers.ts'
import { CLI_VERSION } from './version.ts'

const run = (env: ReturnType<typeof makeEnv>, ...args: string[]) => runCli(args, env.deps)

describe('cli: ayuda y versión', () => {
  it('--version y -V', async () => {
    for (const flag of ['--version', '-V']) {
      const env = makeEnv()
      expect(await run(env, flag)).toBe(0)
      expect(env.cap.out).toBe(`nexo ${CLI_VERSION}\n`)
    }
  })

  it('sin argumentos, --help y help muestran la ayuda general', async () => {
    for (const args of [[], ['--help'], ['-h'], ['help']]) {
      const env = makeEnv()
      expect(await run(env, ...args)).toBe(0)
      expect(env.cap.out).toContain('Uso: nexo')
      expect(env.cap.out).toContain('Códigos de salida')
    }
  })

  it('cada comando tiene su --help y no conecta con el daemon', async () => {
    for (const cmd of [
      'ls',
      'new',
      'split',
      'send',
      'read',
      'focus',
      'kill',
      'close',
      'rename',
      'daemon',
    ]) {
      const env = makeEnv()
      expect(await run(env, cmd, '--help')).toBe(0)
      expect(env.cap.out, cmd).toContain(`nexo ${cmd}`)
      expect(env.connects).toHaveLength(0)
      const env2 = makeEnv()
      expect(await run(env2, 'help', cmd)).toBe(0)
      expect(env2.cap.out).toContain(`nexo ${cmd}`)
    }
  })

  it('--help después de -- es un argumento, no ayuda', async () => {
    const env = makeEnv()
    env.client.workspaces = sampleWorkspaces()
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--', '--help')).toBe(0)
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: '--help' },
    ])
  })
})

describe('cli: errores', () => {
  it('comando desconocido: error de uso en español, sin traza', async () => {
    const env = makeEnv()
    expect(await run(env, 'volar')).toBe(1)
    expect(env.cap.err).toBe('nexo: comando desconocido: volar (mira `nexo --help`)\n')
  })

  it('opción global desconocida', async () => {
    const env = makeEnv()
    expect(await run(env, '--nada', 'ls')).toBe(1)
    expect(env.cap.err).toContain('opción desconocida')
  })

  it('las opciones globales valen antes del comando', async () => {
    const env = makeEnv()
    expect(await run(env, '--json', '--no-start', 'ls')).toBe(0)
    expect(JSON.parse(env.cap.out)).toEqual({ workspaces: [] })
    expect(env.connects).toEqual([{ autostart: false }])
  })

  it('con --json el error sale como JSON válido por stderr', async () => {
    const env = makeEnv()
    expect(await run(env, '--json', 'volar')).toBe(1)
    expect(env.cap.out).toBe('')
    const body = ErrorOutput.parse(JSON.parse(env.cap.err))
    expect(body.error).toMatchObject({ code: 'USAGE', exit: 1 })
  })

  it('los códigos de salida salen del tipo de error', async () => {
    const cases: [unknown, number][] = [
      [clientError('NOT_FOUND'), 2],
      [clientError('INVALID_PARAMS'), 1],
      [clientError('TIMEOUT'), 3],
      [clientError('DISCONNECTED'), 3],
      [clientError('CLOSED'), 3],
      [clientError('ABORTED'), 3],
      [clientError('INTERNAL'), 4],
      [clientError('UNAUTHORIZED'), 4],
      [clientError('INVALID_RESPONSE'), 4],
      [new DiscoveryError('NOT_RUNNING', 'x'), 3],
      [new DiscoveryError('STALE', 'x'), 3],
      [new DiscoveryError('CORRUPT', 'x'), 3],
      [new DiscoveryError('START_TIMEOUT', 'x'), 3],
      [new Error('bug interno con secreto'), 4],
      ['una cadena', 4],
    ]
    for (const [error, code] of cases) {
      const env = makeEnv({
        connect: async () => {
          throw error
        },
      })
      expect(await run(env, 'ls'), String(error)).toBe(code)
      expect(env.cap.err).toMatch(/^nexo: /)
      expect(env.cap.err).not.toContain('secreto')
      expect(env.cap.err.split('\n')).toHaveLength(2)
    }
  })

  it('NEXO_DEBUG=1 agrega la traza; sin él no hay traza', async () => {
    const failing = (debug: boolean) =>
      makeEnv({
        env: debug ? { NEXO_DEBUG: '1' } : {},
        connect: async () => {
          throw new Error('fallo raro')
        },
      })
    const quiet = failing(false)
    await run(quiet, 'ls')
    expect(quiet.cap.err).not.toContain('at ')
    const loud = failing(true)
    await run(loud, 'ls')
    expect(loud.cap.err).toContain('at ')
  })

  it('cierra el cliente aunque el comando falle', async () => {
    const env = makeEnv()
    env.client.handlers.set('workspace.list', () => {
      throw clientError('INTERNAL', 'x')
    })
    expect(await run(env, 'ls')).toBe(4)
    expect(env.client.closed).toBe(true)
  })

  it('classifyError conserva los CliError y el mensaje del daemon', () => {
    const err = classifyError(clientError('CONFLICT', 'demasiadas terminales'))
    expect(err.exitCode).toBe(EXIT.daemon)
    expect(err.message).toContain('demasiadas terminales')
    expect(classifyError(err)).toBe(err)
  })
})
