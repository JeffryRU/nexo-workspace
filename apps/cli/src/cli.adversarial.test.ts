import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { NewOutput } from './schemas.ts'
import {
  clientError,
  ECHO_SCRIPT,
  isAlive,
  isWellFormed,
  makeEnv,
  Sandbox,
  sampleWorkspaces,
  type TestEnv,
  waitUntil,
  workspace,
} from './test-helpers.ts'

const ESC = '\u001b'
const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)
// biome-ignore lint/suspicious/noControlCharactersInRegex: justamente lo que se comprueba
const RAW_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

function setup(options: Parameters<typeof makeEnv>[0] = {}): TestEnv {
  const env = makeEnv(options)
  env.client.workspaces = sampleWorkspaces()
  return env
}

describe('argumentos hostiles', () => {
  const hostile = [
    `${ESC}]0;pwned\u0007`,
    `${ESC}[2J${ESC}[H`,
    `${ESC}]52;c;ZWNobyBoYWNrZWQ=\u0007`,
    '\u009b31m\u009d0;x\u009c',
    '‮gnp.exe',
    'é‍🚀'.repeat(50),
    '\u0000\u0001',
    'a\nb\rc',
    '../../etc/passwd',
    '__proto__',
    'constructor',
    '--',
    '-',
    '-x',
  ]

  it('comandos y opciones desconocidas no reflejan escapes en stderr', async () => {
    for (const h of hostile) {
      for (const args of [[h], [`--${h}`], ['ls', h], ['daemon', h], ['help', h]]) {
        const env = setup()
        await run(env, ...args)
        expect(env.cap.err, JSON.stringify(args)).not.toMatch(RAW_CONTROL)
        expect(env.cap.out.replaceAll('\n', '')).not.toMatch(RAW_CONTROL)
      }
    }
  })

  it('referencias hostiles dan no encontrado (2) o uso (1), nunca eco crudo ni llamadas al daemon', async () => {
    for (const h of hostile) {
      for (const cmd of ['kill', 'close', 'focus', 'read']) {
        const env = setup()
        const code = await run(env, cmd, h)
        expect([1, 2], `${cmd} ${JSON.stringify(h)}`).toContain(code)
        expect(env.cap.err).not.toMatch(RAW_CONTROL)
        for (const m of [
          'terminal.kill',
          'pane.close',
          'tab.close',
          'workspace.close',
          'pane.focus',
        ]) {
          expect(env.client.callsTo(m)).toHaveLength(0)
        }
      }
    }
  })

  it('--json con argumentos hostiles sigue siendo JSON válido', async () => {
    // (tras `--` la opción --json ya no es una opción)
    for (const h of hostile.filter((x) => x !== '--')) {
      const env = setup()
      await run(env, 'kill', h, '--json')
      for (const line of env.cap.err.trim().split('\n')) {
        if (line !== '') expect(() => JSON.parse(line)).not.toThrow()
      }
    }
  })

  it('texto de send con escapes viaja intacto (la terminal de destino decide) y no se refleja', async () => {
    const env = setup()
    const text = `${ESC}]0;titulo\u0007${ESC}[31m`
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--', text)).toBe(0)
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: text },
    ])
    expect(env.cap.out).toBe('')
  })

  it('rename con escapes: lo rechaza el daemon (INVALID_PARAMS) y sale 1 sin eco crudo', async () => {
    const env = setup()
    env.client.handlers.set('tab.rename', () => {
      throw clientError('INVALID_PARAMS', `título inválido: ${ESC}[31m`)
    })
    expect(await run(env, 'rename', 'servidor', `${ESC}[31mrojo`)).toBe(1)
    expect(env.cap.err).not.toContain(ESC)
  })

  it('un millón de argumentos o argumentos enormes no revientan', async () => {
    const env = setup()
    const code = await run(
      env,
      'send',
      'pane-cccc3333-0000',
      ...Array.from({ length: 2000 }, () => 'x'.repeat(1000)),
    )
    expect(code).toBe(0)
    const writes = env.client.callsTo('terminal.write') as { data: string }[]
    for (const w of writes) expect(Buffer.byteLength(w.data)).toBeLessThanOrEqual(64 * 1024)
    expect(writes.map((w) => w.data).join('')).toBe(
      Array.from({ length: 2000 }, () => 'x'.repeat(1000)).join(' '),
    )
  })
})

describe('títulos hostiles en la salida', () => {
  it('ls sanea títulos, nombres y rutas con escapes, bidi y separadores', () => {
    const evil = `${ESC}]0;pwned\u0007${ESC}[2J‮ x\u009b`
    const env = setup()
    env.client.workspaces = [
      workspace(
        `ws-evil0000`,
        evil,
        [
          {
            id: 'tab-evil0000',
            title: evil,
            panes: [{ id: 'pane-evil0000', terminalId: 'term-x', title: evil }],
          },
        ],
        `/ruta/${evil}`,
      ),
    ]
    return run(env, 'ls').then((code) => {
      expect(code).toBe(0)
      expect(env.cap.out).not.toContain(ESC)
      expect(env.cap.out).not.toContain('\u009b')
      expect(env.cap.out).not.toContain('‮')
      expect(env.cap.out).not.toContain(' ')
      expect(env.cap.out).toContain('\\x1b')
      // una sola línea por elemento: el título no puede inyectar líneas
      expect(env.cap.out.trim().split('\n')).toHaveLength(3)
    })
  })

  it('ls --json codifica los controles (nada crudo en la salida)', async () => {
    const env = setup()
    env.client.workspaces = [workspace('ws-evil0000', `a${ESC}[31mb`, [])]
    await run(env, 'ls', '--json')
    expect(env.cap.out).not.toContain(ESC)
    expect(JSON.parse(env.cap.out).workspaces[0].name).toBe(`a${ESC}[31mb`)
  })

  it('read quita las secuencias de la salida de la terminal (títulos, portapapeles, cursor)', async () => {
    const env = setup()
    env.client.handlers.set('terminal.read', () => ({
      data: `ok${ESC}]0;titulo falso\u0007${ESC}]52;c;ZWNobw==\u0007${ESC}[2J${ESC}[31;1mrojo${ESC}[0m\u0007\r\n`,
      offset: 10,
    }))
    expect(await run(env, 'read', 'pane-cccc3333-0000')).toBe(0)
    expect(env.cap.out).toBe('okrojo\n')
  })

  it('daemon log sanea líneas hostiles del registro', async () => {
    const env = setup({
      daemon: { readLog: async () => `{"msg":"${ESC}[31m"}\n${ESC}]0;x\u0007\n` },
    })
    await run(env, 'daemon', 'log')
    expect(env.cap.out).not.toContain(ESC)
  })
})

describe('send --stdin extremo', () => {
  it('5 MB en trozos de 64 KiB como máximo, sin perder ni un byte', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 'abcdefghij\n')
    const env = setup({
      stdin: () =>
        (async function* () {
          for (let at = 0; at < big.length; at += 100_000) yield big.subarray(at, at + 100_000)
        })(),
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(0)
    const writes = env.client.callsTo('terminal.write') as { data: string }[]
    expect(writes.length).toBeGreaterThanOrEqual(80)
    for (const w of writes) expect(Buffer.byteLength(w.data)).toBeLessThanOrEqual(64 * 1024)
    expect(Buffer.from(writes.map((w) => w.data).join('')).equals(big)).toBe(true)
  })

  it('binario arbitrario: no se cuelga, no lanza, y todo lo enviado es texto válido', async () => {
    const bytes = randomBytes(300_000)
    const env = setup({
      stdin: () =>
        (async function* () {
          yield bytes
        })(),
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(0)
    const writes = env.client.callsTo('terminal.write') as { data: string }[]
    for (const w of writes) {
      expect(Buffer.byteLength(w.data)).toBeLessThanOrEqual(64 * 1024)
      expect(isWellFormed(w.data)).toBe(true)
    }
    expect(writes.map((w) => w.data).join('')).toBe(new TextDecoder().decode(bytes))
  })

  it('UTF-8 partido entre trozos de stdin se reconstruye', async () => {
    const rocket = Buffer.from('🚀', 'utf8')
    const env = setup({
      stdin: () =>
        (async function* () {
          yield rocket.subarray(0, 2)
          yield rocket.subarray(2)
        })(),
    })
    await run(env, 'send', 'pane-cccc3333-0000', '--stdin')
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: '🚀' },
    ])
  })

  it('stdin vacío no envía nada y un error al leer stdin sale con código', async () => {
    const env = setup()
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(0)
    expect(env.client.callsTo('terminal.write')).toHaveLength(0)
    const broken = setup({
      stdin: () =>
        (async function* () {
          yield 'a'
          throw new Error('EIO secreto')
        })(),
    })
    expect(await run(broken, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(4)
    expect(broken.cap.err).not.toContain('secreto')
  })

  it('Ctrl+C a mitad de un envío grande lo corta', async () => {
    const env = setup({
      stdin: () =>
        (async function* () {
          yield 'x'.repeat(1_000_000)
        })(),
    })
    let n = 0
    env.client.handlers.set('terminal.write', () => {
      if (++n === 3) env.abort.abort()
      return {}
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(0)
    expect(n).toBe(3)
  })

  it('un RATE_LIMITED permanente termina con error, no en bucle infinito', async () => {
    const env = setup()
    env.client.handlers.set('terminal.write', () => {
      throw clientError('RATE_LIMITED', 'lento', { retryAfterMs: 1 })
    })
    env.abort.abort()
    expect(await run(env, 'send', 'pane-cccc3333-0000', 'x')).toBe(0)
    const env2 = setup()
    env2.client.handlers.set('terminal.write', () => {
      env2.abort.abort()
      throw clientError('RATE_LIMITED', 'lento')
    })
    expect(await run(env2, 'send', 'pane-cccc3333-0000', 'x')).toBe(4)
  })
})

describe('referencias: vacías, ambiguas, enormes', () => {
  it('vacías o solo espacios: error de uso', async () => {
    for (const ref of ['', ' ', '\t', '\n']) {
      const env = setup()
      expect(await run(env, 'focus', ref), JSON.stringify(ref)).toBe(1)
    }
  })

  it('ids ambiguos entre tipos distintos se explican y no actúan', async () => {
    const env = setup()
    env.client.workspaces = [
      workspace('ws-same0000', 'same', [
        { id: 'tab-same0000', title: 'same', panes: [{ id: 'pane-same0000', terminalId: 't' }] },
      ]),
    ]
    expect(await run(env, 'close', 'same')).toBe(1)
    expect(env.cap.err).toContain('ambigua')
    expect(env.client.calls.filter((c) => c.method.endsWith('.close'))).toHaveLength(0)
  })

  it('un id de 1 MB es error de uso sin tocar el daemon', async () => {
    const env = setup()
    expect(await run(env, 'close', 'x'.repeat(1_000_000))).toBe(1)
    expect(env.connects).toHaveLength(0)
  })
})

describe('procesos reales hostiles', () => {
  let sandbox: Sandbox | undefined
  afterEach(async () => {
    await sandbox?.cleanup()
    sandbox = undefined
  })
  const fresh = async () => {
    sandbox = await Sandbox.create()
    return sandbox
  }

  it('NEXO_DAEMON_ENTRY inexistente: error claro (3) sin traza', async () => {
    const sb = await fresh()
    const r = await sb.nexo(['ls'], { env: { NEXO_DAEMON_ENTRY: join(sb.dir, 'no-existe.ts') } })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('NEXO_DAEMON_ENTRY')
    expect(r.stderr).not.toContain('    at ')
  })

  it('un daemon que no arranca da un timeout claro y no cuelga', async () => {
    const sb = await fresh()
    const entry = join(sb.dir, 'muere.mjs')
    await writeFile(entry, 'process.exit(1)\n')
    const started = Date.now()
    const r = await sb.nexo(['ls'], {
      env: { NEXO_DAEMON_ENTRY: entry, NEXO_START_TIMEOUT_MS: '1500' },
    })
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/no respondió en 2 s|no respondió en 1 s/)
    expect(r.stderr).toContain('nexo daemon log')
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('NEXO_START_TIMEOUT_MS inválido es error de uso', async () => {
    const sb = await fresh()
    const r = await sb.nexo(['ls'], { env: { NEXO_START_TIMEOUT_MS: 'abc' } })
    expect(r.code).toBe(1)
  })

  it('daemon.json y token corruptos o viejos: 3, sin traza', async () => {
    const sb = await fresh()
    await writeFile(join(sb.dir, 'daemon.json'), '{no es json')
    await writeFile(join(sb.dir, 'token'), 'x')
    const r = await sb.nexo(['ls', '--no-start'])
    expect(r.code).toBe(3)
    expect(r.stderr).toMatch(/^nexo: /)
    expect(r.stderr.trim().split('\n')).toHaveLength(1)
  })

  it('read --follow con el daemon muriendo a mitad: sale 3 con mensaje, sin traza', async () => {
    const sb = await fresh()
    const daemon = await sb.startDaemon()
    const created = NewOutput.parse(await sb.json(['new', '--', 'node', '-e', ECHO_SCRIPT]))
    const follow = sb.spawnNexo(['read', created.paneId, '--follow'])
    let seen = ''
    let err = ''
    follow.stdout?.on('data', (d: Buffer) => {
      seen += d.toString('utf8')
    })
    follow.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    await waitUntil(async () => seen.includes('LISTO') || undefined)
    const exited = new Promise<number | null>((resolve) => follow.on('close', resolve))
    daemon.kill('SIGKILL')
    const { pid } = { pid: daemon.pid as number }
    await waitUntil(async () => !isAlive(pid) || undefined)
    const code = await exited
    expect(code).toBe(3)
    expect(err).toMatch(/^nexo: .*conexión/m)
    expect(err).not.toContain('    at ')
  })

  it('salida a una tubería cerrada: sin EPIPE ni traza', async () => {
    const sb = await fresh()
    await sb.startDaemon()
    for (let i = 0; i < 5; i++) {
      await sb.nexo([
        'new',
        '--name',
        `pestaña-${i}-${'x'.repeat(200)}`,
        '--',
        'node',
        '-e',
        'setTimeout(()=>{},60000)',
      ])
    }
    const child = sb.spawnNexo(['ls'])
    child.stdout?.destroy()
    let err = ''
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString('utf8')
    })
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    expect(code).toBe(0)
    expect(err).not.toMatch(/EPIPE|ERR_STREAM| {4}at /)
  })

  it.skipIf(process.platform === 'win32')('Ctrl+C en read --follow sale limpio con 0', async () => {
    const sb = await fresh()
    await sb.startDaemon()
    const created = NewOutput.parse(await sb.json(['new', '--', 'node', '-e', ECHO_SCRIPT]))
    const follow = sb.spawnNexo(['read', created.paneId, '--follow'])
    let seen = ''
    follow.stdout?.on('data', (d: Buffer) => {
      seen += d.toString('utf8')
    })
    await waitUntil(async () => seen.includes('LISTO') || undefined)
    const exited = new Promise<number | null>((resolve) => follow.on('close', resolve))
    follow.kill('SIGINT')
    expect(await exited).toBe(0)
  })
})
