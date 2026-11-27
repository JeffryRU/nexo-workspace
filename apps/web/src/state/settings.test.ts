import fc from 'fast-check'
import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import {
  browserStorage,
  createSettings,
  readSettings,
  SETTINGS_KEY,
  type SettingsStorage,
} from './settings.ts'

function memory(initial?: string): SettingsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set(SETTINGS_KEY, initial)
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  }
}

describe('settings', () => {
  it('por omisión las notificaciones están desactivadas', () => {
    expect(readSettings(undefined)).toEqual({
      notifications: false,
      companionHidden: false,
      sidebarCollapsed: false,
    })
    expect(readSettings(memory())).toEqual({
      notifications: false,
      companionHidden: false,
      sidebarCollapsed: false,
    })
  })

  it('guarda y recupera el ajuste', () =>
    createRoot((dispose) => {
      const storage = memory()
      const a = createSettings(storage)
      a.setNotifications(true)
      expect(JSON.parse(storage.data.get(SETTINGS_KEY) as string)).toEqual({
        notifications: true,
        companionHidden: false,
        sidebarCollapsed: false,
      })
      expect(createSettings(storage).notifications()).toBe(true)
      a.setNotifications(false)
      expect(createSettings(storage).notifications()).toBe(false)
      dispose()
    }))

  it('sin almacenamiento sigue funcionando en memoria', () =>
    createRoot((dispose) => {
      const s = createSettings(undefined)
      s.setNotifications(true)
      expect(s.notifications()).toBe(true)
      dispose()
    }))

  it('un almacenamiento que lanza no rompe nada', () =>
    createRoot((dispose) => {
      const broken: SettingsStorage = {
        getItem: () => {
          throw new Error('bloqueado')
        },
        setItem: () => {
          throw new Error('cuota')
        },
      }
      const s = createSettings(broken)
      expect(s.notifications()).toBe(false)
      expect(() => s.setNotifications(true)).not.toThrow()
      expect(s.notifications()).toBe(true)
      dispose()
    }))

  it('browserStorage tolera el acceso bloqueado', () => {
    const win = {
      get localStorage(): SettingsStorage {
        throw new Error('SecurityError')
      },
    }
    expect(browserStorage(win)).toBeUndefined()
  })
})

describe('settings: mascota oculta', () => {
  it('se guarda sin pisar las notificaciones y sobrevive a recargar', () =>
    createRoot((dispose) => {
      const storage = memory()
      const a = createSettings(storage)
      a.setNotifications(true)
      a.setCompanionHidden(true)
      const b = createSettings(storage)
      expect(b.companionHidden()).toBe(true)
      expect(b.notifications()).toBe(true)
      b.setCompanionHidden(false)
      expect(createSettings(storage).companionHidden()).toBe(false)
      expect(createSettings(storage).notifications()).toBe(true)
      dispose()
    }))

  it('un valor que no es booleano vuelve a «visible»', () => {
    expect(readSettings(memory('{"companionHidden":"si"}')).companionHidden).toBe(false)
    expect(readSettings(memory('{"companionHidden":1}')).companionHidden).toBe(false)
  })
})

describe('settings (adversarial y propiedades)', () => {
  it('basura guardada cae a los valores por omisión', () => {
    for (const raw of [
      '',
      '{',
      'null',
      '[]',
      '"x"',
      '42',
      '{"notifications":"yes"}',
      '{"notifications":1}',
    ]) {
      expect(readSettings(memory(raw))).toEqual({
        notifications: false,
        companionHidden: false,
        sidebarCollapsed: false,
      })
    }
  })

  it('ignora campos desconocidos y prototipos hostiles', () => {
    expect(readSettings(memory('{"notifications":true,"__proto__":{"x":1},"otro":1}'))).toEqual({
      notifications: true,
      companionHidden: false,
      sidebarCollapsed: false,
    })
  })

  it('la barra lateral colapsada se guarda, se recupera y tolera basura', () =>
    createRoot((dispose) => {
      const storage = memory()
      const a = createSettings(storage)
      expect(a.sidebarCollapsed()).toBe(false)
      a.setSidebarCollapsed(true)
      expect(createSettings(storage).sidebarCollapsed()).toBe(true)
      expect(readSettings(memory('{"sidebarCollapsed":"si"}')).sidebarCollapsed).toBe(false)
      expect(readSettings(memory('{"sidebarCollapsed":1}')).sidebarCollapsed).toBe(false)
      a.setSidebarCollapsed(false)
      expect(createSettings(storage).sidebarCollapsed()).toBe(false)
      dispose()
    }))

  it('propiedad: cualquier cadena produce un booleano y nunca lanza', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const out = readSettings(memory(raw))
        return typeof out.notifications === 'boolean'
      }),
    )
    fc.assert(
      fc.property(fc.json(), (raw) => typeof readSettings(memory(raw)).notifications === 'boolean'),
    )
  })
})
