import type { ProviderLimits } from '@nexo/contracts'
import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import { mountHistory } from '../history/test-helpers.ts'

const NOW = Date.now()

export const codex = (over: Partial<ProviderLimits> = {}): ProviderLimits => ({
  provider: 'codex',
  status: 'ok',
  windows: [
    { id: 'primary', usedPercent: 42, windowMinutes: 300, resetsAt: NOW + 2 * 3_600_000 },
    { id: 'secondary', usedPercent: 7, windowMinutes: 10080, resetsAt: NOW + 3 * 86_400_000 },
  ],
  source: 'query',
  observedAt: NOW,
  fresh: true,
  ...over,
})

export const claudeUnknown = (): ProviderLimits => ({
  provider: 'fake',
  status: 'unknown',
  windows: [],
  reason: 'sin sesión',
})

const el = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)
const chips = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.limits-chip')].map((c) => [
    c.dataset.provider,
    c.dataset.level,
    c.textContent?.trim(),
  ])

describe('indicador de límites', () => {
  it('muestra el peor porcentaje por proveedor, con color por umbral, y «desconocido»', async () => {
    const h = await mountHistory({ limits: [codex(), claudeUnknown()] })
    await settle(10)
    expect(chips(h.container)).toEqual([
      ['codex', 'ok', 'codex 42 %'],
      ['fake', 'unknown', 'fake desconocido'],
    ])
    expect(h.client.callsOf('limits.status')).toHaveLength(1)
  })

  it('umbrales: 70 % pasa a alto y 90 % a crítico', async () => {
    const mk = (id: string, p: number): ProviderLimits => ({
      provider: id,
      status: 'ok',
      windows: [{ id: 'primary', usedPercent: p }],
    })
    const h = await mountHistory({ limits: [mk('a', 69), mk('b', 70), mk('c', 89), mk('d', 90)] })
    await settle(10)
    expect(chips(h.container).map((c) => c[1])).toEqual(['ok', 'warn', 'warn', 'high'])
  })

  it('no aparece si ningún proveedor ofrece límites', async () => {
    const h = await mountHistory({
      limits: [{ provider: 'ollama', status: 'unsupported', windows: [] }],
    })
    await settle(10)
    expect(el(h.container, '.limits')).toBeNull()
  })

  it('el detalle se despliega con las ventanas, el reinicio local, la frescura y el origen; Escape lo cierra', async () => {
    const h = await mountHistory({ limits: [codex()] })
    await settle(10)
    const toggle = el<HTMLButtonElement>(h.container, '.limits-toggle') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('aria-label')).toContain('Límites de uso: Codex falso 42 %')
    fireEvent.click(toggle)
    await settle(2)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const detail = el(h.container, '#limits-detail') as HTMLElement
    expect(detail.textContent).toContain('Ventana principal (5 h)')
    expect(detail.textContent).toContain('Ventana secundaria (7 d)')
    expect(detail.textContent).toContain('42 % usado')
    expect(detail.textContent).toMatch(/se reinicia \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(detail.textContent).toMatch(/\(en 2 h|\(en 1 h 59 min/)
    expect(detail.textContent).toContain('Dato reciente')
    expect(detail.textContent).toContain('Origen: consulta directa')
    fireEvent.keyDown(detail, { key: 'Escape' })
    expect(el(h.container, '#limits-detail')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('un proveedor desconocido explica por qué en el detalle', async () => {
    const h = await mountHistory({ limits: [claudeUnknown()] })
    await settle(10)
    fireEvent.click(el(h.container, '.limits-toggle') as HTMLElement)
    await settle(2)
    const d = el(h.container, '#limits-detail') as HTMLElement
    expect(d.textContent).toContain('El proveedor aún no ha informado sus límites.')
    expect(d.textContent).toContain('Motivo: sin sesión')
  })

  it('limits.updated sustituye lo que había de ese proveedor y añade los nuevos', async () => {
    const h = await mountHistory({ limits: [codex(), claudeUnknown()] })
    await settle(10)
    h.client.emit('limits.updated', codex({ windows: [{ id: 'primary', usedPercent: 91 }] }))
    await settle(3)
    expect(chips(h.container)[0]).toEqual(['codex', 'high', 'codex 91 %'])
    h.client.emit('limits.updated', {
      provider: 'fake',
      status: 'ok',
      windows: [{ id: 'five_hour', usedPercent: 55 }],
    })
    await settle(3)
    expect(chips(h.container)).toEqual([
      ['codex', 'high', 'codex 91 %'],
      ['fake', 'ok', 'fake 55 %'],
    ])
  })

  it('refrescar pide limits.status con refresh y reemplaza los datos', async () => {
    const h = await mountHistory({
      limits: [codex()],
      setup: (c) => {
        const base = c.handlers.get('limits.status')
        c.handlers.set('limits.status', (p) =>
          (p as { refresh?: boolean }).refresh === true
            ? { providers: [codex({ windows: [{ id: 'primary', usedPercent: 12 }] })] }
            : base?.(p),
        )
      },
    })
    await settle(10)
    fireEvent.click(el(h.container, '.limits-toggle') as HTMLElement)
    await settle(2)
    const refresh = [...h.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Refrescar',
    ) as HTMLButtonElement
    fireEvent.click(refresh)
    await settle(10)
    expect(h.client.callsOf('limits.status').at(-1)?.params).toEqual({ refresh: true })
    expect(chips(h.container)[0]?.[2]).toBe('codex 12 %')
  })

  it('si el refresco falla lo dice y conserva lo anterior', async () => {
    const h = await mountHistory({
      limits: [codex()],
      setup: (c) => {
        const base = c.handlers.get('limits.status')
        c.handlers.set('limits.status', (p) => {
          if ((p as { refresh?: boolean }).refresh === true) throw new Error('proveedor caído')
          return base?.(p)
        })
      },
    })
    await settle(10)
    fireEvent.click(el(h.container, '.limits-toggle') as HTMLElement)
    await settle(2)
    fireEvent.click(
      [...h.container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Refrescar',
      ) as HTMLElement,
    )
    await settle(10)
    expect(el(h.container, '.limits-error')?.textContent).toContain('proveedor caído')
    expect(chips(h.container)[0]?.[2]).toBe('codex 42 %')
  })
})
