import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import { createSettings, SETTINGS_KEY } from '../state/settings.ts'
import { FakeNotifier } from './fake-notifier.ts'
import { createNotifications } from './notifications.ts'
import type { Notifier } from './notifier.ts'

const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(notifier: Notifier, saved?: boolean) {
  const data = new Map<string, string>()
  if (saved !== undefined) data.set(SETTINGS_KEY, JSON.stringify({ notifications: saved }))
  const settings = createSettings({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  })
  const errors: string[] = []
  const n = createNotifications({ notifier, settings, showError: (m) => errors.push(m) })
  return { n, settings, errors, data }
}

describe('createNotifications', () => {
  it('activar pide el permiso y guarda el ajuste', async () => {
    await createRoot(async (dispose) => {
      const notifier = new FakeNotifier({ permission: 'default' })
      const { n, data } = setup(notifier)
      await flush()
      expect(n.state()).toBe('off')
      await n.toggle()
      expect(notifier.requests).toBe(1)
      expect(n.state()).toBe('on')
      expect(n.enabled()).toBe(true)
      expect(JSON.parse(data.get(SETTINGS_KEY) as string)).toEqual({
        notifications: true,
        companionHidden: false,
      })
      await n.toggle()
      expect(n.state()).toBe('off')
      expect(n.enabled()).toBe(false)
      dispose()
    })
  })

  it('si el sistema lo niega, queda desactivado y se explica', async () => {
    await createRoot(async (dispose) => {
      const notifier = new FakeNotifier({ permission: 'default' })
      notifier.onRequest = 'denied'
      const { n, errors } = setup(notifier)
      await n.toggle()
      expect(n.state()).toBe('off')
      expect(errors[0]).toContain('no permitió')
      dispose()
    })
  })

  it('sin soporte lo dice', async () => {
    await createRoot(async (dispose) => {
      const { n, errors } = setup(new FakeNotifier({ permission: 'unsupported' }))
      await n.toggle()
      expect(n.state()).toBe('off')
      expect(errors[0]).toContain('no admite')
      dispose()
    })
  })

  it('ajuste guardado como activo pero permiso retirado: bloqueadas y sin avisos', async () => {
    await createRoot(async (dispose) => {
      const { n } = setup(new FakeNotifier({ permission: 'denied' }), true)
      await flush()
      expect(n.state()).toBe('blocked')
      expect(n.enabled()).toBe(false)
      dispose()
    })
  })

  it('ajuste guardado como activo y permiso concedido: activas', async () => {
    await createRoot(async (dispose) => {
      const { n } = setup(new FakeNotifier({ permission: 'granted' }), true)
      await flush()
      expect(n.state()).toBe('on')
      dispose()
    })
  })

  it('un notificador cuyo permiso o petición lanzan no rompe la interfaz', async () => {
    await createRoot(async (dispose) => {
      const broken: Notifier = {
        supportsClick: true,
        permission: () => Promise.reject(new Error('x')),
        request: () => Promise.reject(new Error('y')),
        notify: () => {},
      }
      const { n, errors } = setup(broken)
      await flush()
      await n.toggle()
      expect(n.state()).toBe('off')
      expect(errors).toHaveLength(1)
      dispose()
    })
  })
})
