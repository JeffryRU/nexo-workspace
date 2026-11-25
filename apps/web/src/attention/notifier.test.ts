import { describe, expect, it, vi } from 'vitest'
import { FakeNotifier } from './fake-notifier.ts'
import {
  detectNotifier,
  type NotificationCtor,
  nullNotifier,
  tauriNotifier,
  webNotifier,
} from './notifier.ts'
import { runNotifierConformance } from './notifier-conformance.ts'

type Made = { title: string; options?: { body?: string; tag?: string }; closed: boolean }

function fakeNotificationApi(permission: string, requested = 'granted') {
  const made: (Made & { onclick: ((e: unknown) => void) | null })[] = []
  class Fake {
    static permission = permission
    static async requestPermission() {
      Fake.permission = requested
      return requested
    }
    onclick: ((e: unknown) => void) | null = null
    closed = false
    title: string
    options?: { body?: string; tag?: string }
    constructor(title: string, options?: { body?: string; tag?: string }) {
      this.title = title
      if (options !== undefined) this.options = options
      made.push(this)
    }
    close() {
      this.closed = true
    }
  }
  return { ctor: Fake as unknown as NotificationCtor, made }
}

runNotifierConformance('FakeNotifier', () => new FakeNotifier())
runNotifierConformance('nullNotifier', () => nullNotifier)
runNotifierConformance('webNotifier', () =>
  webNotifier({ Notification: fakeNotificationApi('granted').ctor }),
)
runNotifierConformance('webNotifier sin API', () => webNotifier({}))
runNotifierConformance('tauriNotifier', () => tauriNotifier(async () => true))
runNotifierConformance('tauriNotifier con fallos', () =>
  tauriNotifier(async () => {
    throw new Error('sin plugin')
  }),
)

describe('webNotifier', () => {
  it('muestra la notificación y su clic enfoca la ventana y avisa', () => {
    const { ctor, made } = fakeNotificationApi('granted')
    const focus = vi.fn()
    const click = vi.fn()
    webNotifier({ Notification: ctor, focus }).notify({ title: 'T', body: 'B', tag: 'x' }, click)
    expect(made[0]?.title).toBe('T')
    expect(made[0]?.options).toEqual({ body: 'B', tag: 'x' })
    made[0]?.onclick?.({})
    expect(focus).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(made[0]?.closed).toBe(true)
  })

  it('sin permiso no muestra nada', () => {
    const { ctor, made } = fakeNotificationApi('default')
    webNotifier({ Notification: ctor }).notify({ title: 'T', body: 'B', tag: 'x' }, () => {})
    expect(made).toHaveLength(0)
  })

  it('pide permiso y traduce el resultado; un rechazo del navegador es denied', async () => {
    const api = fakeNotificationApi('default', 'denied')
    const n = webNotifier({ Notification: api.ctor })
    expect(await n.permission()).toBe('default')
    expect(await n.request()).toBe('denied')
    const broken = {
      permission: 'default',
      requestPermission: async () => {
        throw new Error('x')
      },
    } as unknown as NotificationCtor
    expect(await webNotifier({ Notification: broken }).request()).toBe('denied')
  })

  it('si el constructor lanza, no propaga el error', () => {
    const boom = Object.assign(
      function Boom() {
        throw new TypeError('Illegal constructor')
      },
      { permission: 'granted', requestPermission: async () => 'granted' },
    ) as unknown as NotificationCtor
    expect(() =>
      webNotifier({ Notification: boom }).notify({ title: 'a', body: 'b', tag: 'c' }, () => {}),
    ).not.toThrow()
  })
})

describe('tauriNotifier', () => {
  it('usa los tres comandos del plugin y no pasa de ahí', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = []
    const n = tauriNotifier(async (command, args) => {
      calls.push([command, args])
      return command.endsWith('is_permission_granted') ? true : 'granted'
    })
    expect(await n.permission()).toBe('granted')
    expect(await n.request()).toBe('granted')
    n.notify({ title: 'T', body: 'B', tag: 'x' }, () => {})
    expect(calls.map((c) => c[0])).toEqual([
      'plugin:notification|is_permission_granted',
      'plugin:notification|request_permission',
      'plugin:notification|notify',
    ])
    expect(calls[2]?.[1]).toEqual({ options: { title: 'T', body: 'B' } })
    expect(n.supportsClick).toBe(false)
  })

  it('null es «sin decidir», false es denegado y un fallo es unsupported', async () => {
    expect(await tauriNotifier(async () => null).permission()).toBe('default')
    expect(await tauriNotifier(async () => false).permission()).toBe('denied')
    expect(
      await tauriNotifier(async () => {
        throw new Error('x')
      }).request(),
    ).toBe('unsupported')
  })

  it('un permiso con valor inesperado se trata como unsupported', async () => {
    expect(await tauriNotifier(async () => ({ hostil: true })).request()).toBe('unsupported')
  })
})

describe('detectNotifier', () => {
  it('elige Tauri si hay invoke y la API del navegador si no', async () => {
    const invoke = vi.fn(async () => true)
    expect(detectNotifier({ __TAURI__: { core: { invoke } } }).supportsClick).toBe(false)
    expect(
      detectNotifier({ Notification: fakeNotificationApi('granted').ctor }).supportsClick,
    ).toBe(true)
    expect(await detectNotifier({}).permission()).toBe('unsupported')
    expect(await detectNotifier({ __TAURI__: {} }).permission()).toBe('unsupported')
  })
})
