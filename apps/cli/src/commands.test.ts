import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { LsOutput, NewOutput, ReadOutput, SendOutput, SplitOutput } from './schemas.ts'
import { clientError, makeEnv, sampleWorkspaces, type TestEnv, WORK } from './test-helpers.ts'

function setup(options: Parameters<typeof makeEnv>[0] = {}): TestEnv {
  const env = makeEnv(options)
  env.client.workspaces = sampleWorkspaces()
  return env
}

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

describe('nexo ls', () => {
  it('muestra el árbol espacios -> pestañas -> paneles', async () => {
    const env = setup()
    expect(await run(env, 'ls')).toBe(0)
    expect(env.cap.out).toContain(`espacio ws-aaaa1111  proyecto  ${WORK}`)
    expect(env.cap.out).toContain('  pestaña tab-bbbb2222  servidor  *activa')
    expect(env.cap.out).toContain(
      '    panel pane-cccc3333  terminal  term-dddd4444  "bash"  idle  *enfocado',
    )
    expect(env.cap.out).toContain('sin terminal')
    expect(env.client.closed).toBe(true)
  })

  it('--json valida con el esquema de la CLI', async () => {
    const env = setup()
    expect(await run(env, 'ls', '--json')).toBe(0)
    const parsed = LsOutput.parse(JSON.parse(env.cap.out))
    expect(parsed.workspaces).toHaveLength(2)
    expect(parsed.workspaces[0]?.tabs[0]?.panes[0]?.terminalId).toBe('term-dddd4444-0000')
    expect(env.cap.out.trim().split('\n')).toHaveLength(1)
  })

  it('sin espacios lo dice', async () => {
    const env = makeEnv()
    expect(await run(env, 'ls')).toBe(0)
    expect(env.cap.out).toContain('No hay espacios')
  })

  it('rechaza argumentos de más', async () => {
    const env = setup()
    expect(await run(env, 'ls', 'x')).toBe(1)
    expect(await run(env, 'ls', '--nada')).toBe(1)
  })

  it('--no-start conecta sin autoarranque', async () => {
    const env = setup()
    await run(env, 'ls', '--no-start')
    expect(env.connects).toEqual([{ autostart: false }])
    const env2 = setup()
    await run(env2, 'ls')
    expect(env2.connects).toEqual([{ autostart: true }])
  })
})

describe('nexo new', () => {
  function wire(env: TestEnv) {
    env.client.handlers.set('workspace.create', (p) => ({
      workspace: { id: 'ws-nuevo0000', name: (p as { name: string }).name, tabs: [] },
    }))
    env.client.handlers.set('tab.create', () => ({
      tab: {
        id: 'tab-nuevo0000',
        title: 'T',
        layout: { type: 'leaf', paneId: 'pane-nuevo0000' },
        panes: [{ id: 'pane-nuevo0000', kind: 'terminal', title: 'Terminal', attention: 'idle' }],
        focusedPaneId: 'pane-nuevo0000',
      },
    }))
    env.client.handlers.set('terminal.spawn', () => ({ terminalId: 'term-nuevo0000' }))
  }

  it('reutiliza el espacio de la carpeta actual y lanza el comando dado', async () => {
    const env = setup()
    wire(env)
    expect(await run(env, 'new', '--json', '--name', 'build', '--', 'node', '-e', 'x')).toBe(0)
    expect(NewOutput.parse(JSON.parse(env.cap.out))).toMatchObject({
      workspaceId: 'ws-aaaa1111-0000',
      createdWorkspace: false,
      terminalId: 'term-nuevo0000',
    })
    expect(env.client.callsTo('workspace.create')).toHaveLength(0)
    expect(env.client.callsTo('tab.create')[0]).toMatchObject({ title: 'build' })
    expect(env.client.callsTo('terminal.spawn')[0]).toMatchObject({
      paneId: 'pane-nuevo0000',
      cmd: 'node',
      args: ['-e', 'x'],
      cols: 120,
      rows: 30,
    })
  })

  it('crea el espacio si no existe (por nombre o por carpeta) y usa el tamaño de la terminal', async () => {
    const env = setup({ cwd: '/otra/carpeta', columns: 200, rows: 50 })
    wire(env)
    expect(await run(env, 'new')).toBe(0)
    expect(env.client.callsTo('workspace.create')[0]).toMatchObject({ name: 'carpeta' })
    expect(env.client.callsTo('terminal.spawn')[0]).toMatchObject({
      cols: 200,
      rows: 50,
    })
    const env2 = setup()
    wire(env2)
    await run(env2, 'new', '--workspace', 'nuevo-espacio', '--cwd', '/x')
    expect(env2.client.callsTo('workspace.create')[0]).toMatchObject({
      name: 'nuevo-espacio',
      cwd: resolve('/x'),
    })
  })

  it('--workspace resuelve por nombre o prefijo y falla si es ambiguo', async () => {
    const env = setup()
    wire(env)
    await run(env, 'new', '--workspace', 'otro')
    expect(env.client.callsTo('tab.create')[0]).toMatchObject({ workspaceId: 'ws-ffff6666-0000' })
    const env2 = setup()
    env2.client.workspaces.push({
      ...(env2.client.workspaces[1] as object),
      id: 'ws-ffff7777-0000',
      name: 'otro',
    } as never)
    wire(env2)
    expect(await run(env2, 'new', '--workspace', 'otro')).toBe(1)
    expect(env2.cap.err).toContain('ambigua')
  })

  it('sin comando no envía cmd: el shell por omisión lo elige el daemon', async () => {
    const a = setup({ platform: 'win32', cwd: 'C:wproyecto' })
    wire(a)
    await run(a, 'new')
    const spawn = a.client.callsTo('terminal.spawn')[0] as Record<string, unknown>
    expect(spawn).not.toHaveProperty('cmd')
    expect(spawn).not.toHaveProperty('args')
    const b = setup({})
    wire(b)
    await run(b, 'new', '--', 'node', '-v')
    expect(b.client.callsTo('terminal.spawn')[0]).toMatchObject({ cmd: 'node', args: ['-v'] })
  })

  it('si la terminal no arranca deshace la pestaña (o el espacio creado) y sale 2', async () => {
    const env = setup()
    wire(env)
    env.client.handlers.set('terminal.spawn', () => {
      throw clientError('NOT_FOUND', 'ejecutable no encontrado')
    })
    expect(await run(env, 'new', '--', 'noexiste')).toBe(2)
    expect(env.client.callsTo('tab.close')).toHaveLength(1)
    const env2 = setup({ cwd: '/nuevo' })
    wire(env2)
    env2.client.handlers.set('terminal.spawn', () => {
      throw clientError('NOT_FOUND', 'x')
    })
    expect(await run(env2, 'new')).toBe(2)
    expect(env2.client.callsTo('workspace.close')).toHaveLength(1)
  })

  it('rechaza posicionales y --cwd vacío', async () => {
    const env = setup()
    expect(await run(env, 'new', 'algo')).toBe(1)
    expect(await run(env, 'new', '--cwd', '')).toBe(1)
  })
})

describe('nexo split', () => {
  function wire(env: TestEnv) {
    env.client.handlers.set('pane.split', () => ({
      pane: { id: 'pane-split0000', kind: 'terminal', title: 'Terminal', attention: 'idle' },
      layout: { type: 'leaf', paneId: 'pane-split0000' },
    }))
    env.client.handlers.set('terminal.spawn', () => ({ terminalId: 'term-split0000' }))
  }

  it('divide a la derecha o hacia abajo y lanza la terminal', async () => {
    const env = setup()
    wire(env)
    expect(await run(env, 'split', 'pane-cccc3333-0', '--right', '--json', '--', 'node')).toBe(0)
    expect(SplitOutput.parse(JSON.parse(env.cap.out))).toEqual({
      paneId: 'pane-split0000',
      terminalId: 'term-split0000',
      sourcePaneId: 'pane-cccc3333-0000',
    })
    expect(env.client.callsTo('pane.split')[0]).toMatchObject({ direction: 'row' })
    const env2 = setup()
    wire(env2)
    await run(env2, 'split', 'pane-cccc3333-0000', '--down', '--cwd', '/x')
    expect(env2.client.callsTo('pane.split')[0]).toMatchObject({ direction: 'column' })
    expect(env2.client.callsTo('terminal.spawn')[0]).toMatchObject({
      cwd: expect.stringContaining('x'),
    })
  })

  it('exige exactamente una dirección y un panel', async () => {
    const env = setup()
    wire(env)
    expect(await run(env, 'split', 'pane-cccc3333-0000')).toBe(1)
    expect(await run(env, 'split', 'pane-cccc3333-0000', '--right', '--down')).toBe(1)
    expect(await run(env, 'split', '--right')).toBe(1)
    expect(await run(env, 'split', 'pane-cccc3333-0000', '--right', '--cwd', '')).toBe(1)
    expect(env.client.callsTo('pane.split')).toHaveLength(0)
  })

  it('si la terminal no arranca cierra el panel nuevo', async () => {
    const env = setup()
    wire(env)
    env.client.handlers.set('terminal.spawn', () => {
      throw clientError('CONFLICT', 'demasiadas terminales')
    })
    expect(await run(env, 'split', 'pane-cccc3333-0000', '--right')).toBe(4)
    expect(env.client.callsTo('pane.close')).toEqual([{ paneId: 'pane-split0000' }])
  })

  it('un panel inexistente es 2', async () => {
    const env = setup()
    expect(await run(env, 'split', 'pane-zzzz', '--right')).toBe(2)
  })
})

describe('nexo send', () => {
  it('escribe el texto con --enter', async () => {
    const env = setup()
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--enter', 'echo', 'hola')).toBe(0)
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: 'echo hola\r' },
    ])
    expect(env.cap.out).toBe('')
  })

  it('--json informa bytes y mensajes', async () => {
    const env = setup()
    await run(env, 'send', '--json', 'pane-cccc3333-0000', '--', '-la')
    expect(SendOutput.parse(JSON.parse(env.cap.out))).toMatchObject({ bytes: 3, messages: 1 })
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: '-la' },
    ])
  })

  it('--enter solo envía un retorno', async () => {
    const env = setup()
    await run(env, 'send', 'pane-cccc3333-0000', '--enter')
    expect(env.client.callsTo('terminal.write')).toEqual([
      { terminalId: 'term-dddd4444-0000', data: '\r' },
    ])
  })

  it('--stdin lee de la entrada y trocea en mensajes de 64 KiB como máximo', async () => {
    const big = 'a'.repeat(200 * 1024)
    const env = setup({
      stdin: () =>
        (async function* () {
          yield new TextEncoder().encode(big.slice(0, 100_000))
          yield big.slice(100_000)
        })(),
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin', '--enter')).toBe(0)
    const writes = env.client.callsTo('terminal.write') as { data: string }[]
    expect(writes.length).toBe(4)
    for (const w of writes) expect(Buffer.byteLength(w.data)).toBeLessThanOrEqual(64 * 1024)
    expect(writes.map((w) => w.data).join('')).toBe(`${big}\r`)
  })

  it('reintenta cuando el daemon limita la frecuencia', async () => {
    const env = setup()
    let n = 0
    env.client.handlers.set('terminal.write', () => {
      if (n++ < 2) throw clientError('RATE_LIMITED', 'lento', { retryAfterMs: 20 })
      return {}
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', 'x')).toBe(0)
    expect(n).toBe(3)
  })

  it('un RATE_LIMITED sin pista también reintenta; otros errores no', async () => {
    const env = setup()
    let n = 0
    env.client.handlers.set('terminal.write', () => {
      if (n++ < 1) throw clientError('RATE_LIMITED', 'lento')
      throw clientError('CONFLICT', 'la terminal terminó')
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', 'x')).toBe(4)
    expect(n).toBe(2)
  })

  it('errores de uso y de panel', async () => {
    const env = setup()
    expect(await run(env, 'send')).toBe(1)
    expect(await run(env, 'send', 'pane-cccc3333-0000')).toBe(1)
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin', 'texto')).toBe(1)
    expect(await run(env, 'send', 'pane-cccc3333-1111', 'x')).toBe(2)
    expect(env.cap.err).toContain('no tiene terminal')
  })

  it('rechaza una entrada estándar enorme', async () => {
    const env = setup({
      stdin: () =>
        (async function* () {
          const chunk = new Uint8Array(8 * 1024 * 1024)
          for (let i = 0; i < 9; i++) yield chunk
        })(),
    })
    expect(await run(env, 'send', 'pane-cccc3333-0000', '--stdin')).toBe(1)
    expect(env.cap.err).toContain('MiB')
    expect(env.client.callsTo('terminal.write')).toHaveLength(0)
  })
})

describe('nexo read', () => {
  const ESC = '\u001b'
  function withOutput(env: TestEnv, data: string, offset = data.length) {
    env.client.handlers.set('terminal.read', () => ({ data, offset }))
  }

  it('quita ANSI y muestra las últimas N líneas', async () => {
    const env = setup()
    withOutput(env, `uno\r\n${ESC}[31mdos${ESC}[0m\r\ntres\r\n`)
    expect(await run(env, 'read', 'pane-cccc3333-0000', '--lines', '2')).toBe(0)
    expect(env.cap.out).toBe('dos\ntres\n')
  })

  it('--raw conserva ANSI y --json valida el esquema', async () => {
    const env = setup()
    withOutput(env, `${ESC}[31mrojo${ESC}[0m\n`)
    await run(env, 'read', 'pane-cccc3333-0000', '--raw')
    expect(env.cap.out).toBe(`${ESC}[31mrojo${ESC}[0m\n`)
    const env2 = setup()
    withOutput(env2, `${ESC}[31mrojo${ESC}[0m\n`)
    await run(env2, 'read', 'pane-cccc3333-0000', '--json')
    expect(ReadOutput.parse(JSON.parse(env2.cap.out))).toMatchObject({ text: 'rojo\n', raw: false })
  })

  it('valida --lines', async () => {
    const env = setup()
    for (const bad of ['0', '-1', 'x', '1.5', '99999999999', '']) {
      expect(await run(env, 'read', 'pane-cccc3333-0000', '--lines', bad), bad).toBe(1)
    }
  })

  it('--follow imprime solo lo nuevo, sin duplicar, y termina con la señal', async () => {
    const env = setup()
    withOutput(env, 'viejo\n', 6)
    let gap = 0
    env.client.handlers.set('terminal.read', (p) => {
      if ((p as { fromOffset?: number }).fromOffset === undefined)
        return { data: 'viejo\n', offset: 6 }
      gap++
      return { data: 'entre\n', offset: 12 }
    })
    const done = run(env, 'read', 'pane-cccc3333-0000', '-f')
    await new Promise((r) => setTimeout(r, 20))
    expect(env.client.subscribed).toEqual(['terminal.output', 'terminal.exit'])
    env.client.emit('terminal.output', {
      terminalId: 'term-otra' as never,
      offset: 99,
      data: 'ajeno',
    })
    env.client.emit('terminal.output', {
      terminalId: 'term-dddd4444-0000' as never,
      offset: 12,
      data: 'entre\n',
    })
    env.client.emit('terminal.output', {
      terminalId: 'term-dddd4444-0000' as never,
      offset: 20,
      data: `${ESC}[1mnuevo${ESC}[0m\r\n`,
    })
    env.abort.abort()
    expect(await done).toBe(0)
    expect(gap).toBe(1)
    expect(env.cap.out).toBe('viejo\nentre\nnuevo\n')
    expect(env.client.listenerCount('terminal.output')).toBe(0)
  })

  it('--follow --json emite una línea por trozo', async () => {
    const env = setup()
    withOutput(env, '', 0)
    const done = run(env, 'read', 'pane-cccc3333-0000', '-f', '--json')
    await new Promise((r) => setTimeout(r, 20))
    env.client.emit('terminal.output', {
      terminalId: 'term-dddd4444-0000' as never,
      offset: 3,
      data: 'abc',
    })
    env.abort.abort()
    await done
    const lines = env.cap.out.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1] as string)).toMatchObject({ text: 'abc', offset: 3 })
  })

  it('--follow termina cuando la terminal termina', async () => {
    const env = setup()
    withOutput(env, 'x', 1)
    const done = run(env, 'read', 'pane-cccc3333-0000', '-f')
    await new Promise((r) => setTimeout(r, 20))
    env.client.emit('terminal.exit', {
      terminalId: 'term-otra' as never,
      exitCode: 0,
      signal: null,
    })
    env.client.emit('terminal.exit', {
      terminalId: 'term-dddd4444-0000' as never,
      exitCode: 0,
      signal: null,
    })
    expect(await done).toBe(0)
    expect(env.cap.err).toContain('terminó')
  })

  it('--follow con el daemon muriendo a mitad sale 3 sin traza', async () => {
    const env = setup()
    withOutput(env, 'x', 1)
    const done = run(env, 'read', 'pane-cccc3333-0000', '-f')
    await new Promise((r) => setTimeout(r, 20))
    env.client.emitState('closed')
    expect(await done).toBe(3)
    expect(env.cap.err).toContain('se perdió la conexión')
    expect(env.cap.err).not.toContain('    at ')
  })

  it('--follow recupera lo descartado por contrapresión', async () => {
    const env = setup()
    let phase = 0
    env.client.handlers.set('terminal.read', (p) => {
      if ((p as { fromOffset?: number }).fromOffset === undefined) return { data: 'a', offset: 1 }
      phase++
      return phase === 1 ? { data: '', offset: 1 } : { data: 'perdido', offset: 8 }
    })
    const done = run(env, 'read', 'pane-cccc3333-0000', '-f')
    await new Promise((r) => setTimeout(r, 20))
    env.client.emitResync()
    await new Promise((r) => setTimeout(r, 20))
    env.abort.abort()
    await done
    expect(env.cap.out).toBe('a\nperdido')
  })

  it('--follow con una señal ya cancelada vuelve enseguida y un fallo al suscribir es error', async () => {
    const env = setup()
    withOutput(env, 'x', 1)
    env.abort.abort()
    expect(await run(env, 'read', 'pane-cccc3333-0000', '-f')).toBe(0)
    const env2 = setup()
    withOutput(env2, 'x', 1)
    env2.client.subscribe = async () => {
      throw clientError('DISCONNECTED', 'sin conexión')
    }
    expect(await run(env2, 'read', 'pane-cccc3333-0000', '-f')).toBe(3)
  })

  it('un panel sin terminal es 2', async () => {
    const env = setup()
    expect(await run(env, 'read', 'pane-cccc3333-1111')).toBe(2)
  })
})

describe('focus, kill, close, rename', () => {
  it('focus activa la pestaña y enfoca el panel', async () => {
    const env = setup()
    expect(await run(env, 'focus', 'pane-eeee')).toBe(0)
    expect(env.client.callsTo('tab.focus')).toEqual([{ tabId: 'tab-bbbb2222-1111' }])
    expect(env.client.callsTo('pane.focus')).toEqual([{ paneId: 'pane-eeee5555-0000' }])
  })

  it('kill mata la terminal, con --signal válida', async () => {
    const env = setup()
    expect(await run(env, 'kill', 'pane-cccc3333-0000', '--signal', 'SIGKILL', '--json')).toBe(0)
    expect(env.client.callsTo('terminal.kill')).toEqual([
      { terminalId: 'term-dddd4444-0000', signal: 'SIGKILL' },
    ])
    expect(JSON.parse(env.cap.out)).toMatchObject({ ok: true, action: 'kill', kind: 'pane' })
    expect(await run(env, 'kill', 'pane-cccc3333-0000', '--signal', 'SIGUSR1')).toBe(1)
    expect(await run(env, 'kill', 'pane-cccc3333-1111')).toBe(2)
    await run(env, 'kill', 'pane-cccc3333-0000')
    expect(env.client.callsTo('terminal.kill').at(-1)).toEqual({ terminalId: 'term-dddd4444-0000' })
  })

  it('close resuelve panel, pestaña (por nombre) o espacio', async () => {
    const env = setup()
    await run(env, 'close', 'pane-cccc3333-0000')
    await run(env, 'close', 'pruebas')
    await run(env, 'close', 'otro')
    expect(env.client.callsTo('pane.close')).toEqual([{ paneId: 'pane-cccc3333-0000' }])
    expect(env.client.callsTo('tab.close')).toEqual([{ tabId: 'tab-bbbb2222-1111' }])
    expect(env.client.callsTo('workspace.close')).toEqual([{ workspaceId: 'ws-ffff6666-0000' }])
    expect(env.cap.out).toContain('cerrado panel')
    expect(await run(env, 'close', 'nada')).toBe(2)
    expect(await run(env, 'close')).toBe(1)
  })

  it('rename cambia pestaña o espacio y exige nombre', async () => {
    const env = setup()
    await run(env, 'rename', 'servidor', 'api', 'v2')
    await run(env, 'rename', 'otro', 'nuevo')
    expect(env.client.callsTo('tab.rename')).toEqual([
      { tabId: 'tab-bbbb2222-0000', title: 'api v2' },
    ])
    expect(env.client.callsTo('workspace.rename')).toEqual([
      { workspaceId: 'ws-ffff6666-0000', name: 'nuevo' },
    ])
    expect(await run(env, 'rename', 'servidor')).toBe(1)
    expect(await run(env, 'rename', 'pane-cccc3333-0000', 'x')).toBe(2)
  })

  it('un nombre rechazado por el daemon (INVALID_PARAMS) es error de uso', async () => {
    const env = setup()
    env.client.handlers.set('tab.rename', () => {
      throw clientError('INVALID_PARAMS', 'título inválido')
    })
    expect(await run(env, 'rename', 'servidor', 'x')).toBe(1)
  })
})

describe('referencias', () => {
  it('prefijo ambiguo lista las coincidencias y sale 1', async () => {
    const env = setup()
    expect(await run(env, 'kill', 'pane-cccc')).toBe(1)
    expect(env.cap.err).toContain('ambigua (2 coincidencias)')
    expect(env.cap.err).toContain('pane-cccc3333')
  })

  it('acepta el id sin su prefijo y es exacto antes que prefijo', async () => {
    const env = setup()
    expect(await run(env, 'kill', 'cccc3333-0')).toBe(0)
    expect(env.client.callsTo('terminal.kill')).toHaveLength(1)
  })

  it('referencia vacía o enorme es error de uso', async () => {
    const env = setup()
    expect(await run(env, 'kill', '')).toBe(1)
    expect(await run(env, 'kill', '   ')).toBe(1)
    expect(await run(env, 'kill', 'p'.repeat(100_000))).toBe(1)
    expect(env.client.callsTo('terminal.kill')).toHaveLength(0)
  })

  it('más de 5 coincidencias resume el resto', async () => {
    const env = setup()
    env.client.workspaces = [setupMany(8)]
    expect(await run(env, 'kill', 'pane-')).toBe(1)
    expect(env.cap.err).toContain('y 3 más')
  })
})

function setupMany(n: number) {
  const base = sampleWorkspaces()[0] as unknown as { tabs: { panes: unknown[] }[] }
  const panes = Array.from({ length: n }, (_, i) => ({
    id: `pane-${String(i).padStart(8, '0')}-x`,
    kind: 'terminal',
    title: 'T',
    attention: 'idle',
    terminalId: `term-${i}`,
  }))
  const tab = { ...base.tabs[0], panes, layout: { type: 'leaf', paneId: panes[0]?.id } }
  return { ...(base as object), tabs: [tab] } as never
}

describe('nexo daemon', () => {
  it('status informa versión, pid y puerto', async () => {
    const env = setup()
    env.client.handlers.set('daemon.info', () => ({
      version: '1.2.3',
      protocol: 1,
      pid: 99,
      startedAt: '2026-01-01T00:00:00.000Z',
    }))
    expect(await run(env, 'daemon', 'status')).toBe(0)
    expect(env.cap.out).toContain('versión:  1.2.3')
    expect(env.cap.out).toContain('puerto:   4317')
    expect(env.connects).toEqual([{ autostart: false }])
    const env2 = setup()
    env2.client.handlers.set('daemon.info', () => ({
      version: '1.2.3',
      protocol: 1,
      pid: 99,
      startedAt: 'x',
    }))
    await run(env2, 'daemon', 'status', '--json')
    expect(JSON.parse(env2.cap.out)).toMatchObject({ running: true, pid: 99, port: 4317 })
    expect(env2.cap.out).not.toMatch(/token/i)
  })

  it('status con el daemon detenido sale 3', async () => {
    const { DiscoveryError } = await import('@nexo/client/node')
    const env = setup({
      daemon: {
        locate: async () => {
          throw new DiscoveryError('NOT_RUNNING', 'no')
        },
      },
    })
    expect(await run(env, 'daemon', 'status')).toBe(3)
    expect(env.cap.out).toContain('no está corriendo')
    const env2 = setup({
      daemon: {
        locate: async () => {
          throw new DiscoveryError('NOT_RUNNING', 'no')
        },
      },
    })
    expect(await run(env2, 'daemon', 'status', '--json')).toBe(3)
    expect(JSON.parse(env2.cap.out)).toMatchObject({ running: false })
  })

  it('stop pide daemon.shutdown y espera a que deje de responder', async () => {
    const { DiscoveryError } = await import('@nexo/client/node')
    let alive = true
    const env = setup({
      daemon: {
        locate: async () => {
          if (!alive) throw new DiscoveryError('NOT_RUNNING', 'no')
          return { port: 1, pid: 1 }
        },
      },
    })
    env.client.handlers.set('daemon.shutdown', () => {
      alive = false
      return {}
    })
    expect(await run(env, 'daemon', 'stop')).toBe(0)
    expect(env.cap.out).toContain('detenido')
    expect(env.client.callsTo('daemon.shutdown')).toHaveLength(1)
  })

  it('stop sin daemon es idempotente y sin respuesta de apagado es error', async () => {
    const { DiscoveryError } = await import('@nexo/client/node')
    const env = setup({
      daemon: {
        locate: async () => {
          throw new DiscoveryError('NOT_RUNNING', 'no')
        },
      },
    })
    expect(await run(env, 'daemon', 'stop', '--json')).toBe(0)
    expect(JSON.parse(env.cap.out)).toEqual({ ok: true, wasRunning: false })
    expect(env.connects).toHaveLength(0)
  })

  it('log muestra las últimas líneas saneadas y 2 si no hay registro', async () => {
    const env = setup({
      daemon: { readLog: async () => `uno\n\u001b[31mdos\ntres\n` },
    })
    expect(await run(env, 'daemon', 'log', '-n', '2')).toBe(0)
    expect(env.cap.out).toBe('\\x1b[31mdos\ntres\n')
    const env2 = setup()
    expect(await run(env2, 'daemon', 'log')).toBe(2)
    const env3 = setup({ daemon: { readLog: async () => 'a\nb' } })
    await run(env3, 'daemon', 'log', '--json')
    expect(JSON.parse(env3.cap.out)).toEqual({ lines: ['a', 'b'] })
  })

  it('subcomando desconocido o argumentos de más son error de uso', async () => {
    const env = setup()
    expect(await run(env, 'daemon')).toBe(1)
    expect(await run(env, 'daemon', 'reiniciar')).toBe(1)
    expect(await run(env, 'daemon', 'status', 'x')).toBe(1)
    expect(await run(env, 'daemon', 'log', 'x')).toBe(1)
  })
})
