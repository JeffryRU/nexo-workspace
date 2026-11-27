import type { ProviderLimits } from '@nexo/contracts'
import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import { mountHistory } from '../history/test-helpers.ts'

declare global {
  var __pwned: unknown
}

const el = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)
const win = (usedPercent: number, extra: Record<string, unknown> = {}) =>
  ({ id: 'primary', usedPercent, ...extra }) as ProviderLimits['windows'][number]

describe('indicador de límites: datos absurdos y avalanchas', () => {
  it('porcentajes fuera de rango, NaN o infinitos se acotan y nunca se pintan como NaN', async () => {
    const h = await mountHistory({
      limits: [
        { provider: 'a', status: 'ok', windows: [win(150)] },
        { provider: 'b', status: 'ok', windows: [win(-30)] },
        { provider: 'c', status: 'ok', windows: [win(Number.NaN)] },
        { provider: 'd', status: 'ok', windows: [win(Number.POSITIVE_INFINITY)] },
      ],
    })
    await settle(10)
    const text = [...h.container.querySelectorAll('.limits-chip')].map((c) => c.textContent?.trim())
    expect(text).toEqual(['a 100 %', 'b 0 %', 'c desconocido', 'd 100 %'])
    fireEvent.click(el(h.container, '.limits-toggle') as HTMLElement)
    await settle(2)
    expect(el(h.container, '#limits-detail')?.textContent).not.toContain('NaN')
    for (const fill of h.container.querySelectorAll<HTMLElement>('.limits-bar-fill')) {
      expect(fill.style.width).toMatch(/^(\d+(\.\d+)?)%$/)
      expect(Number.parseFloat(fill.style.width)).toBeLessThanOrEqual(100)
    }
  })

  it('fechas inválidas, etiquetas hostiles y motivos con HTML se muestran como texto', async () => {
    globalThis.__pwned = undefined
    const hostile =
      '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=2</script>'
    const h = await mountHistory({
      limits: [
        {
          provider: 'codex',
          status: 'error',
          windows: [
            win(10, { label: hostile, resetsAt: Number.NaN, windowMinutes: -5 }),
            win(20, { id: 'secondary', resetsAt: 8.64e15 + 1 }),
            win(30, { id: 'tercera', resetsAt: 1 }),
          ],
          observedAt: Number.POSITIVE_INFINITY,
          reason: hostile,
        },
      ],
    })
    await settle(10)
    fireEvent.click(el(h.container, '.limits-toggle') as HTMLElement)
    await settle(2)
    const d = el(h.container, '#limits-detail') as HTMLElement
    expect(d.textContent).not.toContain('NaN')
    expect(d.textContent).toContain('<img src=x')
    for (const tag of ['img', 'script', 'iframe']) expect(d.querySelector(tag)).toBeNull()
    expect(d.textContent).toContain('ya pasó')
    expect(globalThis.__pwned).toBeUndefined()
  })

  it('una avalancha de limits.updated deja el último dato y no multiplica los elementos', async () => {
    const h = await mountHistory({ limits: [] })
    await settle(10)
    const start = performance.now()
    for (let i = 0; i < 3000; i++) {
      h.client.emit('limits.updated', {
        provider: i % 2 === 0 ? 'codex' : 'fake',
        status: 'ok',
        windows: [win(i % 101)],
      })
    }
    await settle(3)
    expect(performance.now() - start).toBeLessThan(5000)
    const chips = [...h.container.querySelectorAll('.limits-chip')].map((c) =>
      c.textContent?.trim(),
    )
    // El último de cada proveedor: i = 2998 (codex, 2998 % 101 = 69) e i = 2999 (fake, 2999 % 101 = 70).
    expect(chips).toEqual(['codex 69 %', 'fake 70 %'])
    expect(h.container.querySelectorAll('.limits')).toHaveLength(1)
  })

  it('un daemon que responde sin proveedores o con basura no rompe la barra de estado', async () => {
    const h = await mountHistory({
      setup: (c) => c.handlers.set('limits.status', () => ({})),
    })
    await settle(10)
    expect(el(h.container, '.limits')).toBeNull()
    expect(el(h.container, '.statusbar')).not.toBeNull()
  })

  it('si limits.status falla no hay indicador ni error visible', async () => {
    const h = await mountHistory({
      setup: (c) =>
        c.handlers.set('limits.status', () => {
          throw new Error('PROVIDER_UNAVAILABLE')
        }),
    })
    await settle(10)
    expect(el(h.container, '.limits')).toBeNull()
    expect(h.container.querySelector('.toast, [role="alert"]')).toBeNull()
  })
})
