import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import {
  AgentActionOutput,
  AgentAttachLine,
  AgentLsOutput,
  AgentNewOutput,
  AgentSendOutput,
} from './schemas.ts'
import {
  agentHandlers,
  agentSession,
  blk,
  makeEnv,
  PERMISSION,
  QUESTION,
  SESSION_ID,
  type TestEnv,
} from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

function setup(blocks: ReturnType<typeof blk>[] = [], options: Parameters<typeof makeEnv>[0] = {}) {
  const env = makeEnv(options)
  agentHandlers(env.client, () => blocks)
  return env
}

const text = (n: number, body: string, complete = true) =>
  blk(n, { type: 'text', text: body, complete })

describe('nexo agent ls', () => {
  it('lista las sesiones en texto y en JSON', async () => {
    const env = setup()
    expect(await run(env, 'agent', 'ls')).toBe(0)
    expect(env.cap.out).toContain(SESSION_ID)
    expect(env.cap.out).toContain('fake')
    const j = setup()
    expect(await run(j, 'agent', 'ls', '--json')).toBe(0)
    expect(AgentLsOutput.parse(JSON.parse(j.cap.out)).sessions).toHaveLength(1)
  })

  it('sin sesiones lo dice', async () => {
    const env = makeEnv()
    env.client.handlers.set('agent.list', () => ({ sessions: [] }))
    expect(await run(env, 'agent', 'ls')).toBe(0)
    expect(env.cap.out).toContain('No hay sesiones')
  })
})

describe('nexo agent new', () => {
  function newEnv() {
    const env = makeEnv()
    env.client.handlers.set('workspace.create', () => ({
      workspace: { id: 'ws-1111aaaa', name: 'proyecto', tabs: [] },
    }))
    env.client.handlers.set('tab.create', () => ({
      tab: { id: 'tab-2222bbbb', title: 't', panes: [{ id: 'pane-first0000' }] },
    }))
    env.client.handlers.set('pane.split', () => ({ pane: { id: 'pane-agent0000' } }))
    env.client.handlers.set('agent.create', () => ({ session: agentSession() }))
    return env
  }

  it('crea pestaña, panel de agente y sesión; cierra el panel inicial', async () => {
    const env = newEnv()
    expect(
      await run(
        env,
        'agent',
        'new',
        '--json',
        '--provider',
        'fake',
        '--model',
        'fake-1',
        '--effort',
        'low',
        '--permissions',
        'plan',
      ),
    ).toBe(0)
    const out = AgentNewOutput.parse(JSON.parse(env.cap.out))
    expect(out.sessionId).toBe(SESSION_ID)
    expect(env.client.calls.map((c) => c.method)).toEqual([
      'workspace.list',
      'workspace.create',
      'tab.create',
      'pane.split',
      'pane.close',
      'agent.create',
    ])
    expect(env.client.callsTo('agent.create')[0]).toMatchObject({
      paneId: 'pane-agent0000',
      provider: 'fake',
      model: 'fake-1',
      effort: 'low',
      permissionMode: 'plan',
    })
  })

  it('usa claude por omisión y salida legible', async () => {
    const env = newEnv()
    expect(await run(env, 'agent', 'new')).toBe(0)
    expect(env.client.callsTo('agent.create')[0]).toMatchObject({ provider: 'claude' })
    expect(env.cap.out).toContain(`creada la sesión ${SESSION_ID}`)
  })

  it('si agent.create falla, deshace lo creado', async () => {
    const env = newEnv()
    env.client.handlers.set('agent.create', () => {
      throw new Error('boom')
    })
    expect(await run(env, 'agent', 'new')).toBe(4)
    expect(env.client.callsTo('workspace.close')).toHaveLength(1)
  })

  it('valida --permissions', async () => {
    const env = newEnv()
    expect(await run(env, 'agent', 'new', '--permissions', 'todo')).toBe(1)
    expect(env.client.callsTo('agent.create')).toHaveLength(0)
  })
})

describe('nexo agent send / interrupt / close', () => {
  it('envía el texto a la sesión por prefijo', async () => {
    const env = setup()
    env.client.handlers.set('agent.send', () => ({ blockId: 'blk-00000001', index: 0, turn: 1 }))
    expect(await run(env, 'agent', 'send', 'aaaa1111', 'hola', 'mundo', '--json')).toBe(0)
    expect(AgentSendOutput.parse(JSON.parse(env.cap.out)).turn).toBe(1)
    expect(env.client.callsTo('agent.send')[0]).toEqual({
      sessionId: SESSION_ID,
      text: 'hola mundo',
    })
  })

  it('lee el texto de la entrada estándar con --stdin', async () => {
    const env = setup([], {
      stdin: async function* () {
        yield 'desde '
        yield 'stdin'
      },
    })
    env.client.handlers.set('agent.send', () => ({ blockId: 'blk-00000001', index: 0, turn: 1 }))
    expect(await run(env, 'agent', 'send', SESSION_ID, '--stdin')).toBe(0)
    expect(env.client.callsTo('agent.send')[0]).toMatchObject({ text: 'desde stdin' })
  })

  it('interrupt y close llaman al daemon', async () => {
    const env = setup()
    expect(await run(env, 'agent', 'interrupt', SESSION_ID, '--json')).toBe(0)
    expect(AgentActionOutput.parse(JSON.parse(env.cap.out)).action).toBe('interrupt')
    const e2 = setup()
    expect(await run(e2, 'agent', 'close', SESSION_ID)).toBe(0)
    expect(e2.cap.out).toContain('cerrada')
    expect(e2.client.callsTo('agent.close')).toEqual([{ sessionId: SESSION_ID }])
  })

  it('sesión inexistente: salida 2; sin subcomando: salida 1', async () => {
    expect(await run(setup(), 'agent', 'close', 'zzz')).toBe(2)
    expect(await run(setup(), 'agent')).toBe(1)
    expect(await run(setup(), 'agent', 'nada')).toBe(1)
  })
})

describe('nexo agent respond', () => {
  it('responde un permiso por número o por id', async () => {
    for (const answer of ['1', 'allow']) {
      const env = setup([PERMISSION(0)])
      expect(await run(env, 'agent', 'respond', SESSION_ID, answer, '--json')).toBe(0)
      expect(env.client.callsTo('agent.respond')[0]).toMatchObject({
        type: 'permission',
        optionId: 'allow',
      })
    }
    const env = setup([PERMISSION(0)])
    await run(env, 'agent', 'respond', SESSION_ID, '2')
    expect(env.client.callsTo('agent.respond')[0]).toMatchObject({ optionId: 'deny' })
  })

  it('responde una pregunta por etiqueta o número', async () => {
    for (const answer of ['B', '2']) {
      const env = setup([QUESTION(0)])
      expect(await run(env, 'agent', 'respond', SESSION_ID, answer)).toBe(0)
      expect(env.client.callsTo('agent.respond')[0]).toMatchObject({
        type: 'question',
        answers: [{ questionId: 'q1', selected: ['B'] }],
      })
    }
  })

  it('rechaza respuestas no válidas y no llama al daemon', async () => {
    for (const answer of ['9', 'C', '0']) {
      const env = setup([QUESTION(0)])
      expect(await run(env, 'agent', 'respond', SESSION_ID, answer)).toBe(1)
      expect(env.client.callsTo('agent.respond')).toHaveLength(0)
    }
    const env = setup([PERMISSION(0)])
    expect(await run(env, 'agent', 'respond', SESSION_ID, 'quizás')).toBe(1)
  })

  it('sin pendientes: no encontrado; con varios: pide --block', async () => {
    expect(await run(setup([text(0, 'x')]), 'agent', 'respond', SESSION_ID, '1')).toBe(2)
    const env = setup([PERMISSION(0), PERMISSION(1)])
    expect(await run(env, 'agent', 'respond', SESSION_ID, '1')).toBe(1)
    expect(await run(env, 'agent', 'respond', SESSION_ID, '--block', 'blk-00000001', '1')).toBe(0)
    expect(env.client.callsTo('agent.respond')[0]).toMatchObject({ blockId: 'blk-00000001' })
  })

  it('texto libre y varias preguntas', async () => {
    const q = blk(0, {
      type: 'question',
      state: 'pending',
      questions: [
        {
          id: 'q1',
          question: 'uno',
          options: [{ label: 'A' }],
          multiSelect: false,
          allowText: false,
        },
        {
          id: 'q2',
          question: 'dos',
          options: [{ label: 'X' }, { label: 'Y' }],
          multiSelect: true,
          allowText: true,
        },
      ],
    })
    const env = setup([q])
    expect(await run(env, 'agent', 'respond', SESSION_ID, '1; X, Y')).toBe(0)
    expect(env.client.callsTo('agent.respond')[0]).toMatchObject({
      answers: [
        { questionId: 'q1', selected: ['A'] },
        { questionId: 'q2', selected: ['X', 'Y'] },
      ],
    })
    const free = setup([q])
    await run(free, 'agent', 'respond', SESSION_ID, 'A; algo mío')
    expect(free.client.callsTo('agent.respond')[0]).toMatchObject({
      answers: [{ selected: ['A'] }, { selected: [], text: 'algo mío' }],
    })
    expect(await run(setup([q]), 'agent', 'respond', SESSION_ID, 'A')).toBe(1)
  })
})

describe('nexo agent attach', () => {
  const doc = [
    blk(0, { type: 'user', text: 'hola' }),
    text(1, 'Hola, ¿qué tal?'),
    blk(2, {
      type: 'action',
      kind: 'exec',
      status: 'ok',
      tool: 'Bash',
      title: 'ls',
      output: 'a.txt\nb.txt\n',
      exitCode: 0,
    }),
    blk(3, { type: 'usage', stopReason: 'end-turn', usage: { inputTokens: 3, outputTokens: 5 } }),
  ]

  it('--no-follow imprime el documento legible y termina', async () => {
    const env = setup(doc)
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow')).toBe(0)
    expect(env.cap.out).toContain('> hola')
    expect(env.cap.out).toContain('Hola, ¿qué tal?')
    expect(env.cap.out).toContain('[Bash] ls')
    expect(env.cap.out).toContain('  | a.txt')
    expect(env.cap.out).toContain('fin del turno: end-turn (3 entrada, 5 salida)')
    expect(env.client.subscribed).toBeUndefined()
  })

  it('--json emite una línea válida por bloque', async () => {
    const env = setup(doc)
    expect(await run(env, 'agent', 'attach', SESSION_ID, '--no-follow', '--json')).toBe(0)
    const lines = env.cap.out.trim().split('\n')
    expect(lines).toHaveLength(4)
    for (const l of lines) AgentAttachLine.parse(JSON.parse(l))
  })

  it('en vivo: pinta deltas, pide el permiso por teclado y termina con la sesión cerrada', async () => {
    const blocks = [blk(0, { type: 'text', text: 'Ho', complete: false, seq: 1 })]
    let feedLine: (line: string) => void = () => {}
    const lines = new Promise<string>((r) => {
      feedLine = r
    })
    const env = setup(blocks, {
      stdin: async function* () {
        yield `${await lines}\n`
      },
    })
    const done = run(env, 'agent', 'attach', SESSION_ID)
    await until(() => env.client.listenerCount('agent.delta') > 0)
    env.client.emit('agent.delta', {
      sessionId: SESSION_ID as never,
      blockId: blocks[0]?.id as never,
      field: 'text',
      seq: 2,
      text: 'la',
    })
    env.client.emit('agent.block', {
      sessionId: SESSION_ID as never,
      block: { ...(blocks[0] as object), text: 'Hola', complete: true, seq: 2 } as never,
    })
    env.client.emit('agent.block', { sessionId: SESSION_ID as never, block: PERMISSION(1) })
    await until(() => env.cap.out.includes('respuesta> '))
    expect(env.cap.out).toContain('Hola\n')
    expect(env.cap.out).toContain('? Permiso: Ejecutar ls')
    expect(env.cap.out).toContain('  1) Permitir')
    feedLine('1')
    await until(() => env.client.callsTo('agent.respond').length === 1)
    expect(env.client.callsTo('agent.respond')[0]).toMatchObject({ optionId: 'allow' })
    env.client.emit('agent.session', { sessionId: SESSION_ID as never, removed: true })
    expect(await done).toBe(0)
    expect(env.cap.out).toContain('[la sesión se cerró]')
    expect(env.client.closed).toBe(true)
  })

  it('sin entrada interactiva avisa cómo responder y sigue', async () => {
    const env = setup([PERMISSION(0)])
    const done = run(env, 'agent', 'attach', SESSION_ID)
    await until(() => env.cap.err.includes('nexo agent respond'))
    env.abort.abort()
    expect(await done).toBe(0)
  })

  it('si se pierde la conexión sale con 3', async () => {
    const env = setup([])
    const done = run(env, 'agent', 'attach', SESSION_ID)
    await until(() => env.client.listenerCount('state') > 0)
    env.client.emitState('closed')
    expect(await done).toBe(3)
  })
})

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error('tiempo agotado')
    await new Promise((r) => setTimeout(r, 5))
  }
}
