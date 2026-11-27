import type {
  CompanionManifest,
  CompanionStateView,
  MethodParams,
  MethodResult,
} from '@nexo/contracts'
import { vi } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import { mountApp } from '../test-app.tsx'
import { FakeClient, mkPane, mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'
import type { CompanionSource } from './cache.ts'

export const b64 = (bytes: ArrayLike<number>): string =>
  btoa(String.fromCharCode(...Array.from(bytes)))

export type FakeAsset = {
  mime?: string
  /** Bytes del recurso (por omisión, 4 bytes cualquiera). */
  bytes?: number[]
  /** Sustituye el base64 (para probar datos corruptos). */
  data?: string
  /** Declara otro tamaño del que realmente hay. */
  declaredBytes?: number
  fail?: string
  /** La respuesta espera a que se llame a esta función. */
  gate?: Promise<void>
}

export type FakePackage = {
  manifest: CompanionManifest
  assets: Record<string, FakeAsset>
  getFails?: string
  gate?: Promise<void>
}

const NOW = 1_700_000_000_000

export function mkManifest(id = 'tiny', over: Partial<CompanionManifest['states']> = {}) {
  return {
    format: 1,
    id,
    name: id === 'tiny' ? 'Tiny' : id.toUpperCase(),
    version: '1.0.0',
    author: { name: 'Nexo' },
    license: 'CC0-1.0',
    states: {
      idle: { src: 'idle.png' },
      thinking: { src: 'think.png' },
      waiting: {
        src: 'sheet.png',
        sheet: { frameWidth: 8, frameHeight: 8, frames: 4, fps: 10 },
      },
      error: { src: 'error.svg' },
      ...over,
    },
  } as CompanionManifest
}

export function mkPackage(id = 'tiny', over: Partial<FakePackage> = {}): FakePackage {
  const tag = (n: number) => [n, n + 1, n + 2, n + 3]
  return {
    manifest: mkManifest(id),
    assets: {
      'idle.png': { mime: 'image/png', bytes: tag(1) },
      'think.png': { mime: 'image/png', bytes: tag(10) },
      'sheet.png': { mime: 'image/png', bytes: tag(20) },
      'error.svg': { mime: 'image/svg+xml', bytes: tag(30) },
    },
    ...over,
  }
}

/** Fuente de recursos falsa para probar el caché sin la aplicación. */
export function fakeSource(packages: Record<string, FakePackage>) {
  const calls: { method: string; params: unknown }[] = []
  const source: CompanionSource = {
    async get(p: MethodParams<'companion.get'>) {
      calls.push({ method: 'get', params: p })
      const pkg = packages[p.id]
      if (pkg === undefined) throw new Error('NOT_FOUND: no existe')
      await pkg.gate
      if (pkg.getFails !== undefined) throw new Error(pkg.getFails)
      return {
        companion: { manifest: pkg.manifest, assets: [], totalBytes: 0 },
      } as MethodResult<'companion.get'>
    },
    async asset(p: MethodParams<'companion.asset'>) {
      calls.push({ method: 'asset', params: p })
      const a = packages[p.id]?.assets[p.path]
      if (a === undefined) throw new Error('NOT_FOUND: sin recurso')
      await a.gate
      if (a.fail !== undefined) throw new Error(a.fail)
      const bytes = a.bytes ?? [1, 2, 3, 4]
      return {
        mime: a.mime ?? 'image/png',
        bytes: a.declaredBytes ?? bytes.length,
        data: a.data ?? b64(bytes),
      } as MethodResult<'companion.asset'>
    },
  }
  return { source, calls }
}

/** Cuenta las URL de objeto creadas y revocadas (jsdom no las implementa). */
export function stubObjectUrls() {
  const created: string[] = []
  const revoked: string[] = []
  let n = 0
  const create = vi.fn((_blob: Blob) => {
    const url = `blob:nexo-test/${++n}`
    created.push(url)
    return url
  })
  const revoke = vi.fn((url: string) => void revoked.push(url))
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = create as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revoke
  return {
    created,
    revoked,
    live: () => created.filter((u) => !revoked.includes(u)),
    restore() {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    },
  }
}

export type CompanionHarnessOptions = {
  packages?: Record<string, FakePackage>
  selected?: string | null
  state?: CompanionStateView['state']
  invalid?: { id: string; reason: string }[]
  stateFails?: boolean
  storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }
}

/** Aplicación con un daemon falso que sirve `companion.*`. */
export async function mountCompanion(options: CompanionHarnessOptions = {}) {
  const packages = options.packages ?? { tiny: mkPackage('tiny') }
  const view: CompanionStateView = {
    state: options.state ?? 'idle',
    since: NOW,
    selected: options.selected === undefined ? 'tiny' : options.selected,
  }
  const { source } = fakeSource(packages)
  const client = new FakeClient()
  client.handlers.set('agent.providers', () => ({ providers: [] }))
  client.handlers.set('companion.state', () => {
    if (options.stateFails === true) throw new Error('sin estado')
    return { ...view }
  })
  client.handlers.set('companion.list', () => ({
    companions: Object.values(packages).map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      license: p.manifest.license,
      author: p.manifest.author.name,
    })),
    invalid: options.invalid ?? [],
    selected: view.selected,
  }))
  client.handlers.set('companion.get', (p) => source.get(p as MethodParams<'companion.get'>))
  client.handlers.set('companion.asset', (p) => source.asset(p as MethodParams<'companion.asset'>))
  client.handlers.set('companion.select', (p) => {
    const id = (p as { id: string | null }).id
    if (id !== null && packages[id] === undefined) throw new Error('NOT_FOUND: no existe')
    view.selected = id
    return { selected: id }
  })
  const app = await mountApp(
    snapshotOf([mkWorkspace('w1', [{ ...mkTab('t1', ['p1']), panes: [mkPane('p1')] }])]),
    client,
    options.storage === undefined ? {} : { storage: options.storage },
  )
  await settle(12)
  const dock = () => app.container.querySelector<HTMLElement>('.companion-dock')
  return {
    ...app,
    packages,
    view,
    dock,
    img: () => app.container.querySelector<HTMLImageElement>('.companion-dock img'),
    /** El daemon publica un estado nuevo. */
    emit(next: Partial<CompanionStateView> & { since?: number }) {
      client.emit('companion.state', { ...view, ...next })
    },
    async open() {
      app.container.querySelector<HTMLButtonElement>('.companion-toggle')?.click()
      await settle(12)
    },
  }
}

export type CompanionHarness = Awaited<ReturnType<typeof mountCompanion>>
