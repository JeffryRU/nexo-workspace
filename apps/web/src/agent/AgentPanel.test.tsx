import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { unavailableNote } from './Composer.tsx'
import { bid, blocks, FAKE_PROVIDER, mountAgent, SID, settle } from './test-helpers.ts'

const text = (el: Element | null) => el?.textContent ?? ''

describe('panel de agente: documento', () => {
  it('pinta cada tipo de bloque con su semántica', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.user(0, 'Arregla el bug'),
        blocks.reasoning(1, 'Pienso un poco'),
        blocks.text(2, 'Hecho: **listo** y `código`'),
        blocks.action(3, { title: 'npm test', exitCode: 1, durationMs: 1500, status: 'error' }),
        blocks.plan(4),
        blocks.error(5),
        blocks.usage(6),
      ],
    })
    const feed = h.container.querySelector('[role="feed"]')
    expect(feed).not.toBeNull()
    expect(h.container.querySelectorAll('[data-block-id]')).toHaveLength(7)
    expect(text(h.container.querySelector('.bubble'))).toBe('Arregla el bug')
    expect(h.container.querySelector('.blk-text strong')?.textContent).toBe('listo')
    expect(h.container.querySelector('.blk-text code')?.textContent).toBe('código')
    // Acción: cabecera con estado, tipo y código de salida; el cuerpo está plegado.
    const action = h.container.querySelector('.blk-action')
    expect(action?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Con error')
    expect(text(action)).toContain('npm test')
    expect(text(action)).toContain('código 1')
    expect(action?.querySelector('.fold-body')).toBeNull()
    expect(h.container.querySelector('.blk-plan li[data-status="in-progress"]')).not.toBeNull()
    expect(h.container.querySelector('.blk-error')?.getAttribute('role')).toBeNull()
    expect(h.container.querySelector('.err')?.getAttribute('role')).toBe('alert')
    expect(text(h.container.querySelector('.usage'))).toContain('$0.01')
  })

  it('el razonamiento y las acciones se despliegan con el teclado y conservan su estado', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.reasoning(0, 'Razón **oculta**'),
        blocks.action(1, {
          kind: 'exec',
          output: 'ok \u001b[31mrojo\u001b[0m\u001b]8;;http://evil\u0007x\u001b]8;;\u0007',
          input: '{"command":"ls"}',
        }),
      ],
    })
    const heads = h.container.querySelectorAll<HTMLButtonElement>('.fold-head')
    expect(heads[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(h.container.querySelector('.reasoning .fold-body')).toBeNull()
    fireEvent.click(heads[0] as HTMLElement)
    expect(heads[0]?.getAttribute('aria-expanded')).toBe('true')
    expect(h.container.querySelector('.reasoning .fold-body strong')?.textContent).toBe('oculta')
    fireEvent.click(heads[1] as HTMLElement)
    const out = h.container.querySelector('.action pre.output:last-of-type, .action .fold-body pre')
    expect(out).not.toBeNull()
    expect(h.container.querySelector('.ansi-fg-1')?.textContent).toBe('rojo')
    expect(h.container.querySelector('.action .fold-body')?.textContent).not.toContain('evil')
    expect(h.model.expanded(bid(1))()).toBe(true)
  })

  it('una acción edit muestra el diff unificado con sus líneas clasificadas', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.action(0, {
          kind: 'edit',
          title: 'Editar a.ts',
          path: 'src/a.ts',
          diff: {
            path: 'src/a.ts',
            patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-viejo\n+nuevo\n',
          },
        }),
      ],
    })
    fireEvent.click(h.container.querySelector('.fold-head') as HTMLElement)
    expect(h.container.querySelectorAll('.diff-add')).toHaveLength(1)
    expect(h.container.querySelectorAll('.diff-del')).toHaveLength(1)
    expect(h.container.querySelectorAll('.diff-hunk')).toHaveLength(1)
    expect(text(h.container.querySelector('.diff-stats'))).toContain('+1')
  })

  it('los deltas se agrupan por fotograma y el bloque crece sin recrearse', async () => {
    const h = await mountAgent({ blocks: [blocks.text(0, '', { complete: false })] })
    const before = h.container.querySelector('[data-block-id]')
    for (let i = 1; i <= 50; i++) h.emitDelta(bid(0), i, `p${i} `)
    // Sin fotograma todavía: el DOM no cambió (un solo fotograma pendiente para las 50 ráfagas).
    expect(text(h.container.querySelector('.blk-text'))).not.toContain('p50')
    await h.flush()
    expect(text(h.container.querySelector('.blk-text'))).toContain('p1 p2')
    expect(text(h.container.querySelector('.blk-text'))).toContain('p50')
    expect(h.container.querySelector('[data-block-id]')).toBe(before)
    expect(h.container.querySelector('.caret')).not.toBeNull()
    h.emitBlock(blocks.text(0, 'fin', { seq: 50 }))
    await h.flush()
    expect(h.container.querySelector('.caret')).toBeNull()
  })

  it('un bloque nuevo que llega por evento se añade al final', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)] })
    h.emitBlock(blocks.text(1, 'respuesta'))
    await h.flush()
    expect(h.container.querySelectorAll('[data-block-id]')).toHaveLength(2)
    expect(h.container.querySelector('[role="feed"]')?.getAttribute('aria-busy')).toBe('false')
  })

  it('avisa si el texto llegó recortado', async () => {
    const h = await mountAgent({ blocks: [blocks.text(0, 'x', { truncated: true })] })
    expect(text(h.container.querySelector('.notice'))).toContain('recortado')
  })
})

describe('panel de agente: permisos', () => {
  const pendingPerm = () => [blocks.user(0), blocks.permission(1)]

  it('muestra las 4 opciones, avisa de lo pendiente y responde con el clic', async () => {
    const h = await mountAgent({ blocks: pendingPerm(), session: { status: 'needs-input' } })
    const buttons = h.container.querySelectorAll<HTMLButtonElement>('.perm-option')
    expect(buttons).toHaveLength(4)
    expect(text(h.container.querySelector('.agent-banner.pending'))).toContain('1 pendiente')
    h.client.handlers.set('agent.respond', () => ({}))
    fireEvent.click(buttons[1] as HTMLElement)
    await settle()
    expect(h.client.callsOf('agent.respond')[0]?.params).toEqual({
      type: 'permission',
      sessionId: SID,
      blockId: bid(1),
      optionId: 'always',
    })
  })

  it('las teclas 1-4 eligen y las flechas mueven el foco entre las opciones', async () => {
    const h = await mountAgent({ blocks: pendingPerm(), session: { status: 'needs-input' } })
    h.client.handlers.set('agent.respond', () => ({}))
    const buttons = [...h.container.querySelectorAll<HTMLButtonElement>('.perm-option')]
    buttons[0]?.focus()
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[1])
    fireEvent.keyDown(buttons[1] as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(buttons[3])
    fireEvent.keyDown(buttons[3] as HTMLElement, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons[3])
    fireEvent.keyDown(buttons[3] as HTMLElement, { key: '3' })
    await settle()
    expect(h.client.callsOf('agent.respond')[0]?.params).toMatchObject({ optionId: 'no' })
    // Una tecla sin opción (5) no responde.
    fireEvent.keyDown(buttons[0] as HTMLElement, { key: '9' })
    expect(h.client.callsOf('agent.respond')).toHaveLength(1)
  })

  it('un permiso resuelto muestra el resultado y no ofrece botones', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.permission(0, { state: 'accepted', selectedOptionId: 'once' }),
        blocks.permission(1, { state: 'rejected', selectedOptionId: 'no' }),
        blocks.permission(2, { state: 'cancelled' }),
        blocks.permission(3, { state: 'accepted', selectedOptionId: 'always' }),
        blocks.permission(4, { state: 'rejected', selectedOptionId: 'never' }),
      ],
    })
    expect(h.container.querySelectorAll('.perm-option')).toHaveLength(0)
    const results = [...h.container.querySelectorAll('.perm-result')].map((e) => e.textContent)
    expect(results[0]).toBe('Permitido')
    expect(results[1]).toBe('Rechazado')
    expect(results[2]).toBe('Cancelado')
    expect(results[3]).toBe('Permitido siempre')
    expect(results[4]).toBe('Rechazado siempre')
  })

  it('la pista de teclas usa el número real de opciones', async () => {
    const two = [
      { id: 'allow', label: 'Permitir', kind: 'allow-once' },
      { id: 'deny', label: 'Rechazar', kind: 'reject-once' },
    ]
    const h = await mountAgent({
      blocks: [blocks.permission(0, { options: two })],
      session: { status: 'needs-input' },
    })
    expect(text(h.container.querySelector('.perm .hint'))).toContain('Pulsa 1-2 ')
    const one = await mountAgent({
      blocks: [blocks.permission(0, { options: [two[0]] })],
      session: { status: 'needs-input' },
    })
    expect(text(one.container.querySelector('.perm .hint'))).toContain('Pulsa 1 ')
    const four = await mountAgent({ blocks: pendingPerm(), session: { status: 'needs-input' } })
    expect(text(four.container.querySelector('.perm .hint'))).toContain('Pulsa 1-4 ')
  })

  it('Alt+Mayús+↓ lleva el foco al siguiente permiso pendiente', async () => {
    const h = await mountAgent({
      blocks: [blocks.permission(0), blocks.text(1, 'x'), blocks.question(2)],
      session: { status: 'needs-input' },
    })
    const panel = h.container.querySelector('.agent-panel') as HTMLElement
    fireEvent.keyDown(panel, { key: 'ArrowDown', altKey: true, shiftKey: true })
    await settle()
    expect(document.activeElement?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe(
      bid(0),
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowDown',
      altKey: true,
      shiftKey: true,
    })
    await settle()
    expect(document.activeElement?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe(
      bid(2),
    )
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: 'ArrowUp',
      altKey: true,
      shiftKey: true,
    })
    await settle()
    expect(document.activeElement?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe(
      bid(0),
    )
  })

  it('con la sesión cerrada no se puede responder', async () => {
    const h = await mountAgent({ blocks: pendingPerm(), session: { status: 'needs-input' } })
    h.client.emit('agent.session', { sessionId: SID, removed: true })
    await settle()
    for (const b of h.container.querySelectorAll<HTMLButtonElement>('.perm-option')) {
      expect(b.disabled).toBe(true)
    }
    expect(text(h.container.querySelector('.agent-banner'))).toContain('cerró')
  })
})

describe('panel de agente: preguntas', () => {
  it('opción única + texto libre: responde con validateAnswers satisfecho', async () => {
    const h = await mountAgent({ blocks: [blocks.question(0)], session: { status: 'needs-input' } })
    h.client.handlers.set('agent.respond', () => ({}))
    const submit = h.container.querySelector<HTMLButtonElement>('button[type="submit"].primary')
    expect(submit?.disabled).toBe(true)
    const radios = h.container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    fireEvent.click(radios[1] as HTMLElement)
    expect(submit?.disabled).toBe(false)
    const free = h.container.querySelector<HTMLInputElement>('.ask-text')
    fireEvent.input(free as HTMLElement, { target: { value: ' con matiz ' } })
    fireEvent.submit(h.container.querySelector('form.ask') as HTMLElement)
    await settle()
    expect(h.client.callsOf('agent.respond')[0]?.params).toEqual({
      type: 'question',
      sessionId: SID,
      blockId: bid(0),
      answers: [{ questionId: 'q1', selected: ['Azul'], text: 'con matiz' }],
    })
  })

  it('multiselección: se pueden marcar y desmarcar varias', async () => {
    const q = blocks.question(0, {
      questions: [
        {
          id: 'm',
          question: 'Elige',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
          multiSelect: true,
          allowText: false,
        },
      ],
    })
    const h = await mountAgent({ blocks: [q], session: { status: 'needs-input' } })
    h.client.handlers.set('agent.respond', () => ({}))
    const boxes = h.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    fireEvent.click(boxes[0] as HTMLElement)
    fireEvent.click(boxes[2] as HTMLElement)
    fireEvent.click(boxes[0] as HTMLElement)
    fireEvent.click(boxes[1] as HTMLElement)
    fireEvent.submit(h.container.querySelector('form.ask') as HTMLElement)
    await settle()
    expect(h.client.callsOf('agent.respond')[0]?.params).toMatchObject({
      answers: [{ questionId: 'm', selected: ['C', 'B'] }],
    })
  })

  it('no envía si falta una respuesta y muestra lo respondido', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.question(0),
        blocks.question(1, {
          state: 'answered',
          answers: [{ questionId: 'q1', selected: ['Rojo'], text: 'quizá' }],
        }),
      ],
      session: { status: 'needs-input' },
    })
    fireEvent.submit(h.container.querySelector('form.ask.pending') as HTMLElement)
    await settle()
    expect(h.client.callsOf('agent.respond')).toHaveLength(0)
    expect(text(h.container.querySelector('form.ask[data-state="answered"]'))).toContain(
      'Rojo, quizá',
    )
  })
})

describe('panel de agente: redactor', () => {
  const area = (h: Awaited<ReturnType<typeof mountAgent>>) =>
    h.container.querySelector('textarea.composer-input') as HTMLTextAreaElement

  it('Intro envía, Mayús+Intro no, y el texto se limpia', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)], session: { status: 'done' } })
    h.client.handlers.set('agent.send', () => ({ blockId: bid(9), index: 9, turn: 2 }))
    fireEvent.input(area(h), { target: { value: 'hola mundo' } })
    fireEvent.keyDown(area(h), { key: 'Enter', shiftKey: true })
    await settle()
    expect(h.client.callsOf('agent.send')).toHaveLength(0)
    fireEvent.keyDown(area(h), { key: 'Enter', isComposing: true })
    expect(h.client.callsOf('agent.send')).toHaveLength(0)
    fireEvent.keyDown(area(h), { key: 'Enter' })
    await settle()
    expect(h.client.callsOf('agent.send')[0]?.params).toEqual({
      sessionId: SID,
      text: 'hola mundo',
    })
    expect(area(h).value).toBe('')
  })

  it('no envía texto vacío ni mientras el agente trabaja; ofrece interrumpir', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)], session: { status: 'working' } })
    h.client.handlers.set('agent.interrupt', () => ({}))
    fireEvent.input(area(h), { target: { value: 'otra cosa' } })
    fireEvent.keyDown(area(h), { key: 'Enter' })
    await settle()
    expect(h.client.callsOf('agent.send')).toHaveLength(0)
    expect(area(h).value).toBe('otra cosa')
    fireEvent.click(h.container.querySelector('.interrupt') as HTMLElement)
    await settle()
    expect(h.client.callsOf('agent.interrupt')[0]?.params).toEqual({ sessionId: SID })
    fireEvent.keyDown(area(h), { key: 'Escape' })
    await settle()
    expect(h.client.callsOf('agent.interrupt')).toHaveLength(2)
  })

  it('el botón de interrumpir desaparece al terminar el turno', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)], session: { status: 'working' } })
    expect(h.container.querySelector('.interrupt')).not.toBeNull()
    h.emitStatus('done')
    await settle()
    expect(h.container.querySelector('.interrupt')).toBeNull()
  })

  it('con la sesión en error o cerrada, el redactor queda deshabilitado', async () => {
    const h = await mountAgent({
      blocks: [blocks.error(0, { fatal: true })],
      session: { status: 'error' },
    })
    expect(area(h).disabled).toBe(true)
    expect(area(h).placeholder).toContain('error')
    expect(h.container.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true)
  })

  it('la sesión cerrada muestra el aviso y deshabilita el redactor', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)], session: { status: 'done' } })
    expect(area(h).disabled).toBe(false)
    h.client.emit('agent.session', { sessionId: SID, removed: true })
    await settle()
    expect(area(h).disabled).toBe(true)
    expect(area(h).placeholder).toContain('cerrada')
  })

  it('con sesión, los chips son de solo lectura', async () => {
    const h = await mountAgent({
      blocks: [],
      session: { model: 'm1', effort: 'high', permissionMode: 'plan', cwd: '/proyecto' },
    })
    const chips = [...h.container.querySelectorAll('.chip.fixed')].map((c) => c.textContent)
    expect(chips).toEqual(['Proveedor falso', 'Modelo uno', 'high', 'Solo planificar', '/proyecto'])
    expect(h.container.querySelectorAll('select.chip')).toHaveLength(0)
  })

  it('los chips de una sesión usan los nombres del proveedor y del esfuerzo, y caen al id si no los conocen', async () => {
    const named = await mountAgent({
      blocks: [],
      session: { model: 'm2', effort: 'think', permissionMode: 'ask', cwd: '/p' },
    })
    expect(
      [...named.container.querySelectorAll('.chip.fixed')].map((c) => c.textContent).slice(0, 3),
    ).toEqual(['Proveedor falso', 'Modelo dos', 'Razonar'])
    const unknown = await mountAgent({
      blocks: [],
      providers: [],
      session: { model: 'x1', permissionMode: 'ask', cwd: '/p' },
    })
    expect(
      [...unknown.container.querySelectorAll('.chip.fixed')].map((c) => c.textContent).slice(0, 2),
    ).toEqual(['fake', 'x1'])
  })

  it('el estado de la sesión se anuncia en una región de estado', async () => {
    const h = await mountAgent({ session: { status: 'needs-input' } })
    expect(text(h.container.querySelector('.agent-panel > .sr-only'))).toBe('Necesita tu respuesta')
  })
})

describe('panel de agente sin sesión', () => {
  it('muestra los chips de los proveedores y crea la sesión con el primer mensaje', async () => {
    const h = await mountAgent({ withSession: false })
    expect(text(h.container.querySelector('.agent-empty'))).toContain('Nuevo agente')
    const selects = [...h.container.querySelectorAll<HTMLSelectElement>('select.chip')]
    expect(selects.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Proveedor',
      'Modelo',
      'Esfuerzo',
      'Permisos',
    ])
    // Elegir modelo m2 (sin lista de esfuerzos propia → usa los del proveedor) y modo plan.
    fireEvent.change(selects[1] as HTMLElement, { target: { value: 'm2' } })
    fireEvent.change(selects[3] as HTMLElement, { target: { value: 'plan' } })
    await settle()
    const effort = h.container.querySelector<HTMLSelectElement>('select[aria-label="Esfuerzo"]')
    expect([...(effort?.options ?? [])].map((o) => o.value)).toEqual(['', 'low', 'medium', 'high'])
    fireEvent.change(effort as HTMLElement, { target: { value: 'medium' } })
    fireEvent.input(h.container.querySelector('.chip-cwd') as HTMLElement, {
      target: { value: '/otra' },
    })
    h.client.handlers.set('agent.create', () => ({ session: h.state.session }))
    h.client.handlers.set('agent.send', () => ({ blockId: bid(0), index: 0, turn: 1 }))
    const area = h.container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.input(area, { target: { value: 'empieza' } })
    fireEvent.keyDown(area, { key: 'Enter' })
    await h.flush()
    expect(h.client.callsOf('agent.create')[0]?.params).toEqual({
      paneId: 'p1',
      provider: 'fake',
      model: 'm2',
      effort: 'medium',
      permissionMode: 'plan',
      cwd: '/otra',
    })
    expect(h.client.callsOf('agent.send')[0]?.params).toEqual({ sessionId: SID, text: 'empieza' })
    // La sesión ya existe: los chips pasan a ser de solo lectura.
    expect(h.container.querySelectorAll('select.chip')).toHaveLength(0)
    expect(h.container.querySelector('[role="feed"]')).not.toBeNull()
  })

  it('cambiar de proveedor reinicia las elecciones', async () => {
    const other = {
      ...FAKE_PROVIDER,
      id: 'otro',
      name: 'Otro',
      capabilities: {
        ...FAKE_PROVIDER.capabilities,
        models: [],
        efforts: [],
        permissionModes: ['plan' as const],
      },
    }
    const h = await mountAgent({
      withSession: false,
      providers: [FAKE_PROVIDER, other],
    })
    const provider = h.container.querySelector<HTMLSelectElement>('select[aria-label="Proveedor"]')
    fireEvent.change(provider as HTMLElement, { target: { value: 'otro' } })
    await settle()
    expect(h.container.querySelector('select[aria-label="Modelo"]')).toBeNull()
    expect(h.container.querySelector('select[aria-label="Esfuerzo"]')).toBeNull()
    const perms = h.container.querySelector<HTMLSelectElement>('select[aria-label="Permisos"]')
    expect([...(perms?.options ?? [])].map((o) => o.value)).toEqual(['plan'])
  })

  it('sin proveedores disponibles lo dice y no deja enviar', async () => {
    const h = await mountAgent({
      withSession: false,
      providers: [
        {
          ...FAKE_PROVIDER,
          available: false,
        },
      ],
    })
    expect(text(h.container.querySelector('.chips'))).toContain('No hay proveedores')
    fireEvent.input(h.container.querySelector('textarea') as HTMLElement, {
      target: { value: 'hola' },
    })
    expect(h.container.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true)
  })

  it('un proveedor no disponible se ve deshabilitado con su motivo y no se puede elegir', async () => {
    const down = {
      ...FAKE_PROVIDER,
      id: 'ollama',
      name: 'Ollama',
      available: false,
      reason: 'Ollama no responde en http://127.0.0.1:11434',
    }
    const h = await mountAgent({ withSession: false, providers: [down, FAKE_PROVIDER] })
    const select = h.container.querySelector<HTMLSelectElement>('select[aria-label="Proveedor"]')
    const options = [...(select?.options ?? [])]
    expect(options.map((o) => [o.value, o.disabled, o.textContent])).toEqual([
      ['ollama', true, 'Ollama (no disponible)'],
      ['fake', false, 'Proveedor falso'],
    ])
    expect(options[0]?.title).toBe('Ollama no responde en http://127.0.0.1:11434')
    expect(select?.value).toBe('fake')
    expect(text(h.container.querySelector('.chips [role="note"]'))).toContain(
      'Ollama no responde en http://127.0.0.1:11434',
    )
  })

  it('el aviso de no disponible no repite el nombre si el motivo ya lo trae, y lo antepone si no', () => {
    expect(unavailableNote({ name: 'Ollama', reason: 'Ollama no responde en X' })).toBe(
      'Ollama no responde en X',
    )
    expect(unavailableNote({ name: 'Codex', reason: 'sin sesión' })).toBe('Codex: sin sesión')
    expect(unavailableNote({ name: 'Codex' })).toBe('Codex: no disponible')
  })

  it('con todos no disponibles muestra el selector deshabilitado, los motivos y no deja enviar', async () => {
    const h = await mountAgent({
      withSession: false,
      providers: [{ ...FAKE_PROVIDER, available: false, reason: 'no está instalado' }],
    })
    const select = h.container.querySelector<HTMLSelectElement>('select[aria-label="Proveedor"]')
    expect([...(select?.options ?? [])].every((o) => o.disabled)).toBe(true)
    expect(text(h.container.querySelector('.chips'))).toContain('no está instalado')
    expect(h.container.querySelector('select[aria-label="Modelo"]')).toBeNull()
  })

  it('los esfuerzos conocidos se muestran con su nombre en español', async () => {
    const ollama = {
      ...FAKE_PROVIDER,
      id: 'ollama',
      name: 'Ollama',
      capabilities: {
        ...FAKE_PROVIDER.capabilities,
        efforts: ['think', 'no-think', 'raro'],
        models: [],
      },
    }
    const h = await mountAgent({ withSession: false, providers: [ollama] })
    const effort = h.container.querySelector<HTMLSelectElement>('select[aria-label="Esfuerzo"]')
    expect([...(effort?.options ?? [])].map((o) => o.textContent)).toEqual([
      'Esfuerzo predeterminado',
      'Razonar',
      'Sin razonar',
      'raro',
    ])
  })

  it('un fallo al cargar los proveedores se muestra con reintento, sin bloquear el redactor', async () => {
    const h = await mountAgent({ withSession: false, providersFail: true })
    expect(h.container.querySelector('.chips [role="alert"]')?.textContent).toContain(
      'No se pudieron cargar',
    )
    // Se puede escribir aunque los chips fallaran.
    const area = h.container.querySelector('textarea') as HTMLTextAreaElement
    expect(area.disabled).toBe(false)
    h.client.handlers.set('agent.providers', () => ({ providers: [FAKE_PROVIDER] }))
    fireEvent.click(h.container.querySelector('.chips .text-button') as HTMLElement)
    await settle()
    expect(h.container.querySelector('select[aria-label="Proveedor"]')).not.toBeNull()
  })
})
