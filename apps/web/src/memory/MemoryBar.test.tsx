import { describe, expect, it } from 'vitest'
import { mkSession, SID, settle } from '../agent/test-helpers.ts'
import { mountMemory } from './test-helpers.ts'

const bar = (h: { container: HTMLElement }) => h.container.querySelector<HTMLElement>('.memory-bar')
const renewButton = (h: { container: HTMLElement }) =>
  [...(bar(h)?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.includes('Renovar')) as
    | HTMLButtonElement
    | undefined

describe('franja de memoria del panel de agente', () => {
  it('una sesión que recibió memoria lo indica, con las renovaciones', async () => {
    const h = await mountMemory({
      session: { memory: { seedTokens: 1500, renewals: 2, renewing: false } },
    })
    await settle(8)
    const badge = h.container.querySelector('[data-testid="memory-badge"]')
    expect(badge?.textContent).toBe('Memoria recibida · 2 renovación(es)')
    expect(badge?.getAttribute('title')).toContain('1,5 k')
  })

  it('sin memoria recibida y con la memoria apagada no se pinta la franja', async () => {
    const h = await mountMemory({ status: { enabled: false } })
    await settle(8)
    expect(bar(h)).toBeNull()
  })

  it('con la memoria encendida pero sin siembra, solo ofrece renovar', async () => {
    const h = await mountMemory()
    await settle(8)
    expect(h.container.querySelector('[data-testid="memory-badge"]')).toBeNull()
    expect(renewButton(h)?.disabled).toBe(false)
  })

  it('«Renovar sesión» llama a agent.renew y se bloquea mientras tarda', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await mountMemory({
      session: { memory: { seedTokens: 10, renewals: 0, renewing: false } },
      setup: (client) => {
        client.handlers.set('agent.renew', async () => {
          await gate
          return {
            session: mkSession({ memory: { seedTokens: 10, renewals: 1, renewing: false } }),
          }
        })
      },
    })
    await settle(8)
    renewButton(h)?.click()
    await settle(4)
    expect(h.client.callsOf('agent.renew')).toEqual([
      { method: 'agent.renew', params: { sessionId: SID } },
    ])
    expect(renewButton(h)).toBeUndefined()
    expect(bar(h)?.textContent).toContain('Renovando…')
    release()
    await settle(8)
    expect(renewButton(h)?.disabled).toBe(false)
  })

  it('refleja «renovando» y el nuevo contador cuando llegan por agent.session', async () => {
    const h = await mountMemory({
      session: { memory: { seedTokens: 10, renewals: 0, renewing: false } },
    })
    await settle(8)
    h.client.emit('agent.session', {
      session: mkSession({ memory: { seedTokens: 10, renewals: 0, renewing: true } }),
    })
    await settle(4)
    expect(bar(h)?.textContent).toContain('Renovando…')
    h.client.emit('agent.session', {
      session: mkSession({ memory: { seedTokens: 12, renewals: 1, renewing: false } }),
    })
    await settle(4)
    expect(h.container.querySelector('[data-testid="memory-badge"]')?.textContent).toContain(
      '1 renovación(es)',
    )
  })

  it('no se puede renovar con un turno en curso', async () => {
    const h = await mountMemory({ session: { status: 'working' } })
    await settle(8)
    expect(renewButton(h)?.disabled).toBe(true)
  })

  it('un error del daemon al renovar sale en la barra de errores y la franja vuelve a quedar libre', async () => {
    const h = await mountMemory({
      setup: (client) => {
        client.handlers.set('agent.renew', () => {
          throw new Error('no hay memoria que sembrar')
        })
      },
    })
    await settle(8)
    renewButton(h)?.click()
    await settle(8)
    expect(h.container.querySelector('.toast')?.textContent).toContain('no hay memoria que sembrar')
    expect(renewButton(h)?.disabled).toBe(false)
  })
})
