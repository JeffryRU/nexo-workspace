import { describe, expect, it } from 'vitest'
import {
  COMPANION_METHOD_NAMES,
  COMPANION_STATES,
  CompanionAssetPath,
  CompanionId,
  CompanionManifest,
  companionMethods,
} from './companion.ts'
import { events } from './events.ts'
import { LIMITS } from './limits.ts'

const manifest = {
  format: 1,
  id: 'tiny',
  name: 'Tiny',
  version: '1.2.3-beta.1',
  author: { name: 'Nexo', url: 'https://example.org/x' },
  license: 'MIT OR Apache-2.0',
  states: { idle: { src: 'idle.png' } },
}

describe('CompanionManifest', () => {
  it('acepta el manifiesto mínimo y uno completo', () => {
    expect(CompanionManifest.safeParse(manifest).success).toBe(true)
    expect(
      CompanionManifest.safeParse({
        ...manifest,
        description: 'd',
        states: {
          idle: { src: 'a/b.svg' },
          thinking: {
            src: 's.webp',
            sheet: { frameWidth: 8, frameHeight: 8, frames: 4, columns: 2, fps: 2.5, loop: false },
          },
          waiting: { src: 'w.gif' },
          busy: { src: 'b.png' },
          done: { src: 'd.png' },
          error: { src: 'e.png' },
        },
      }).success,
    ).toBe(true)
  })

  it('rechaza lo que no cumple el formato', () => {
    const bad: Record<string, unknown>[] = [
      { ...manifest, format: 2 },
      { ...manifest, states: {} },
      { ...manifest, states: { idle: { src: 'a.png' }, dizzy: { src: 'b.png' } } },
      { ...manifest, version: '1.0' },
      { ...manifest, license: '' },
      { ...manifest, author: { name: 'x', url: 'ftp://x' } },
      { ...manifest, author: {} },
      { ...manifest, extra: true },
      { ...manifest, states: { idle: { src: 'a.png', extra: 1 } } },
      {
        ...manifest,
        states: {
          idle: { src: 'a.png', sheet: { frameWidth: 8, frameHeight: 8, frames: 0, fps: 1 } },
        },
      },
      {
        ...manifest,
        states: {
          idle: { src: 'a.png', sheet: { frameWidth: 8, frameHeight: 8, frames: 300, fps: 1 } },
        },
      },
    ]
    for (const b of bad)
      expect(CompanionManifest.safeParse(b).success, JSON.stringify(b)).toBe(false)
  })
})

describe('CompanionId y CompanionAssetPath', () => {
  it('ids', () => {
    for (const ok of ['a', 'tiny', 'a-b_c9', 'x'.repeat(48)])
      expect(CompanionId.safeParse(ok).success).toBe(true)
    for (const bad of ['', 'A', '-a', '_a', 'a b', 'a/b', '..', 'x'.repeat(49), 'ñ'])
      expect(CompanionId.safeParse(bad).success, bad).toBe(false)
  })

  it('rutas de recurso', () => {
    for (const ok of ['a.png', 'a/b.webp', 'A_b-c.1.gif', 'a/b/c/d.svg', 'IDLE.PNG']) {
      expect(CompanionAssetPath.safeParse(ok).success, ok).toBe(true)
    }
    for (const bad of [
      '',
      '.png',
      '../a.png',
      'a/../b.png',
      '/a.png',
      'C:/a.png',
      'C:\\a.png',
      'a\\b.png',
      '\\\\h\\s\\a.png',
      'a b.png',
      'a.png.',
      'a./b.png',
      'a.jpg',
      'a',
      'a/b/c/d/e.png',
      'a//b.png',
      'a.png:s',
      `${'a'.repeat(LIMITS.maxCompanionPathLength)}.png`,
    ]) {
      expect(CompanionAssetPath.safeParse(bad).success, bad).toBe(false)
    }
  })
})

describe('registro de métodos y eventos', () => {
  it('declara los cinco métodos y el evento', () => {
    expect(COMPANION_METHOD_NAMES).toEqual([
      'companion.list',
      'companion.get',
      'companion.select',
      'companion.asset',
      'companion.state',
    ])
    expect(Object.keys(events)).toContain('companion.state')
    expect(COMPANION_STATES).toEqual(['idle', 'thinking', 'waiting', 'busy', 'done', 'error'])
  })

  it('select admite id o null y rechaza claves de más', () => {
    const p = companionMethods['companion.select'].params
    expect(p.safeParse({ id: null }).success).toBe(true)
    expect(p.safeParse({ id: 'tiny' }).success).toBe(true)
    expect(p.safeParse({}).success).toBe(false)
    expect(p.safeParse({ id: 'tiny', x: 1 }).success).toBe(false)
    expect(p.safeParse({ id: '../x' }).success).toBe(false)
  })

  it('asset acota los bytes de la respuesta', () => {
    const r = companionMethods['companion.asset'].result
    expect(r.safeParse({ mime: 'image/png', bytes: 3, data: 'AAAA' }).success).toBe(true)
    expect(r.safeParse({ mime: 'text/html', bytes: 3, data: 'AAAA' }).success).toBe(false)
    expect(
      r.safeParse({ mime: 'image/png', bytes: LIMITS.maxCompanionAssetBytes + 1, data: 'A' })
        .success,
    ).toBe(false)
    expect(r.safeParse({ mime: 'image/png', bytes: 1, data: 'A'.repeat(900_000) }).success).toBe(
      false,
    )
  })

  it('el evento companion.state exige un estado conocido', () => {
    const e = events['companion.state']
    expect(e.safeParse({ state: 'busy', since: 1, selected: null }).success).toBe(true)
    expect(e.safeParse({ state: 'dizzy', since: 1, selected: null }).success).toBe(false)
    expect(e.safeParse({ state: 'idle', since: -1, selected: null }).success).toBe(false)
  })
})
