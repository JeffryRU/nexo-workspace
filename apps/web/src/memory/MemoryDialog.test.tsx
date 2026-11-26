import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { blocks, SID, settle } from '../agent/test-helpers.ts'
import { mountMemory, obs, openMemory, USAGE } from './test-helpers.ts'

const dialog = (h: { container: HTMLElement }) =>
  h.container.querySelector<HTMLElement>('.memory-dialog')
const text = (el: Element | null | undefined) => el?.textContent ?? ''

describe('ventana de memoria', () => {
  it('el botón de la barra dice si está activada y abre la ventana; Escape la cierra', async () => {
    const h = await mountMemory()
    await settle(8)
    const button = h.container.querySelector<HTMLButtonElement>('.memory-toggle')
    expect(text(button)).toBe('Memoria: Activada')
    expect(button?.getAttribute('data-state')).toBe('on')
    expect(dialog(h)).toBeNull()
    await openMemory(h)
    expect(dialog(h)?.getAttribute('role')).toBe('dialog')
    fireEvent.keyDown(dialog(h) as HTMLElement, { key: 'Escape' })
    expect(dialog(h)).toBeNull()
  })

  it('muestra los ajustes: interruptor, resumidor y pausa', async () => {
    const h = await mountMemory({ status: { pausedReason: 'Ollama no responde' } })
    await openMemory(h)
    const sw = dialog(h)?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(sw?.checked).toBe(true)
    expect(text(dialog(h)?.querySelector('[data-testid="memory-summarizer"]'))).toContain(
      'Resumidor: fake',
    )
    expect(text(dialog(h))).toContain('En pausa: Ollama no responde')
  })

  it('el interruptor llama a memory.configure y refresca; la memoria sigue apagada por omisión', async () => {
    const h = await mountMemory({ status: { enabled: false } })
    await settle(8)
    expect(text(h.container.querySelector('.memory-toggle'))).toBe('Memoria: Apagada')
    await openMemory(h)
    const sw = dialog(h)?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    ) as HTMLInputElement
    expect(sw.checked).toBe(false)
    fireEvent.click(sw)
    await settle(10)
    expect(h.client.callsOf('memory.configure')).toEqual([
      { method: 'memory.configure', params: { enabled: true } },
    ])
    expect(dialog(h)?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(text(h.container.querySelector('.memory-toggle'))).toBe('Memoria: Activada')
  })

  it('el selector de renovación manda el umbral o null', async () => {
    const h = await mountMemory({ status: { renewAtTokens: 50_000 } })
    await openMemory(h)
    const select = dialog(h)?.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('50000')
    select.value = ''
    fireEvent.change(select)
    await settle(8)
    select.value = '200000'
    fireEvent.change(select)
    await settle(8)
    expect(h.client.callsOf('memory.configure').map((c) => c.params)).toEqual([
      { renewAtTokens: null },
      { renewAtTokens: 200_000 },
    ])
  })

  it('un fallo al guardar el ajuste se muestra como alerta', async () => {
    const h = await mountMemory()
    h.client.handlers.set('memory.configure', () => {
      throw new Error('no se pudo guardar')
    })
    await openMemory(h)
    fireEvent.click(dialog(h)?.querySelector('input[type="checkbox"]') as HTMLInputElement)
    await settle(10)
    expect(text(dialog(h)?.querySelector('.memory-error[role="alert"]'))).toContain(
      'No se pudo guardar el ajuste',
    )
  })

  it('muestra el costo del Observador y del Reflector, el total y lo acumulado de la carpeta', async () => {
    const h = await mountMemory()
    await openMemory(h)
    const rows = [...(dialog(h)?.querySelectorAll('.memory-cost tbody tr') ?? [])].map((r) =>
      [...r.children].map((c) => text(c)),
    )
    expect(rows).toEqual([
      ['Observador', '4', '1,2 k', '90', '$0.0042'],
      ['Reflector', '1', '1,2 k', '90', '$0.01'],
      ['Total desde que arrancó el daemon', '5', '2,4 k', '180', '$0.01'],
      ['Acumulado de esta carpeta', '9', '1,2 k', '90', '$0.0042'],
    ])
    expect(USAGE.calls).toBe(3)
  })

  it('lista la reflexión y las observaciones de la carpeta con prioridad, alcance y origen', async () => {
    const h = await mountMemory({
      reflection: {
        generation: 3,
        createdAt: 1,
        coversThroughSeq: 2,
        text: 'Usamos pnpm.',
        sources: [],
      },
    })
    await openMemory(h)
    expect(text(dialog(h))).toContain('Carpeta: /work')
    expect(text(dialog(h)?.querySelector('.memory-reflection'))).toBe('Usamos pnpm.')
    expect(text(dialog(h))).toContain('Generación 3')
    const items = [...(dialog(h)?.querySelectorAll('.memory-obs') ?? [])]
    expect(items).toHaveLength(2)
    expect(text(items[0]?.querySelector('.memory-text'))).toBe('observación 1')
    expect(items[1]?.getAttribute('data-priority')).toBe('high')
    expect(text(items[1])).toContain('alta')
    expect(text(items[1])).toContain('sesión')
    expect(text(items[0])).toContain('bloques 1 a 2')
  })

  it('sin observaciones ni reflexión lo dice; sin carpeta pide abrir una sesión', async () => {
    const h = await mountMemory({ observations: [] })
    await openMemory(h)
    expect(text(dialog(h))).toContain('Aún no hay reflexión.')
    expect(text(dialog(h))).toContain('Aún no hay observaciones en esta carpeta.')
  })

  it('memory.updated refresca las observaciones sin reabrir la ventana', async () => {
    const h = await mountMemory({ observations: [obs(1)] })
    await openMemory(h)
    expect(dialog(h)?.querySelectorAll('.memory-obs')).toHaveLength(1)
    h.memory.observations.push(obs(2), obs(3))
    h.client.emit('memory.updated', {
      cwd: '/work',
      kind: 'observe',
      observations: 3,
      generation: 0,
      updatedAt: 5,
    })
    await settle(10)
    expect(dialog(h)?.querySelectorAll('.memory-obs')).toHaveLength(3)
  })

  it('«Ver texto original» pide memory.recall y muestra los bloques como texto', async () => {
    const h = await mountMemory()
    h.client.handlers.set('memory.recall', () => ({
      blocks: [blocks.user(1, 'usemos pnpm'), blocks.text(2, 'de acuerdo, **pnpm**')],
      truncated: false,
    }))
    await openMemory(h)
    const first = dialog(h)?.querySelector('.memory-obs') as HTMLElement
    fireEvent.click(first.querySelector('button') as HTMLButtonElement)
    await settle(10)
    expect(h.client.callsOf('memory.recall')[0]?.params).toEqual({
      sessionId: SID,
      range: { from: 1, to: 2 },
    })
    const source = first.querySelector('.memory-source')
    expect(text(source)).toContain('usuario')
    expect(text(source)).toContain('usemos pnpm')
    // Markdown sin interpretar
    expect(text(source)).toContain('**pnpm**')
    expect(source?.querySelector('strong')).toBeNull()
    fireEvent.click(first.querySelector('button') as HTMLButtonElement)
    expect(first.querySelector('.memory-source')).toBeNull()
  })

  it('si la sesión ya no está abierta, lo explica en vez de fallar', async () => {
    const h = await mountMemory()
    h.client.handlers.set('memory.recall', () => {
      throw new Error('NOT_FOUND: sesión de agente inexistente')
    })
    await openMemory(h)
    const first = dialog(h)?.querySelector('.memory-obs') as HTMLElement
    fireEvent.click(first.querySelector('button') as HTMLButtonElement)
    await settle(10)
    expect(text(first.querySelector('.memory-source'))).toContain('La sesión ya no está abierta')
  })

  it('«Ir al bloque» cierra la ventana y lleva el panel de la sesión al bloque de origen', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? blocks.user(i, `pregunta ${i}`) : blocks.text(i, `respuesta ${i}`),
    )
    const h = await mountMemory({
      blocks: many,
      observations: [obs(1, { range: { from: 40, to: 41 } })],
    })
    await openMemory(h)
    const go = [...(dialog(h)?.querySelectorAll('.memory-obs button') ?? [])].find(
      (b) => text(b) === 'Ir al bloque',
    ) as HTMLButtonElement
    expect(go).toBeDefined()
    fireEvent.click(go)
    await settle(10)
    h.frames.flush()
    await settle(4)
    expect(dialog(h)).toBeNull()
    // el salto lo consumió el panel de esa sesión
    expect(h.appModel.ui.jump()).toBeUndefined()
    expect(h.model.positionOfBlockRange({ from: 40, to: 41 })).toBe(40)
  })

  it('una observación de una sesión que no está en ningún panel no ofrece saltar', async () => {
    const h = await mountMemory({
      observations: [obs(1, { sessionId: 'agent-session-00000099' as never })],
    })
    await openMemory(h)
    const labels = [...(dialog(h)?.querySelectorAll('.memory-obs button') ?? [])].map((b) =>
      text(b),
    )
    expect(labels).toEqual(['Ver texto original'])
  })

  it('con el daemon sin memoria (error) la ventana no revienta', async () => {
    const h = await mountMemory({
      setup: (client) => {
        const fail = () => {
          throw new Error('la memoria no está disponible')
        }
        client.handlers.set('memory.status', fail)
        client.handlers.set('memory.list', fail)
      },
    })
    await openMemory(h)
    expect(text(dialog(h))).toContain('No se pudo leer la memoria')
    expect(dialog(h)?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(
      true,
    )
  })
})
