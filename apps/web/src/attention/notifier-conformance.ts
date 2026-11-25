import { describe, expect, it } from 'vitest'
import type { Notifier } from './notifier.ts'

const PERMISSIONS = ['granted', 'denied', 'default', 'unsupported']

/** Suite que debe cumplir cualquier adaptador de `Notifier` (el falso, el web, el de Tauri). */
export function runNotifierConformance(name: string, make: () => Notifier): void {
  describe(`Notifier: ${name}`, () => {
    it('permission() y request() devuelven un estado conocido y no lanzan', async () => {
      const n = make()
      expect(PERMISSIONS).toContain(await n.permission())
      expect(PERMISSIONS).toContain(await n.request())
    })

    it('notify() no lanza con textos vacíos, enormes u hostiles', () => {
      const n = make()
      const hostile = '<img src=x onerror=alert(1)>\u0000\u001b[31m'
      expect(() => n.notify({ title: '', body: '', tag: '' }, () => {})).not.toThrow()
      expect(() =>
        n.notify({ title: hostile, body: 'x'.repeat(100_000), tag: hostile }, () => {}),
      ).not.toThrow()
    })

    it('declara si soporta clic', () => {
      expect(typeof make().supportsClick).toBe('boolean')
    })
  })
}
