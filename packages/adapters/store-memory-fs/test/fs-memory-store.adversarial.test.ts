import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AgentSessionId, ProjectMemory } from '@nexo/contracts'
import { appendObservations, MemoryStoreError } from '@nexo/core'
import { FakeLogger } from '@nexo/testkit'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_PROJECT_BYTES, FsMemoryStore } from '../src/index.ts'
import { fileFor, tempStateDir } from './helpers.ts'

const S1 = 's1' as AgentSessionId
const PROJECT = '/work/app'
const add = (text: string) => (m: ProjectMemory) =>
  appendObservations(
    m,
    [
      {
        at: 1,
        priority: 'medium',
        scope: 'project',
        sessionId: S1,
        range: { from: 0, to: 0 },
        text,
      },
    ],
    1,
  )

let state: Awaited<ReturnType<typeof tempStateDir>>
let logger: FakeLogger
let store: FsMemoryStore
beforeEach(async () => {
  state = await tempStateDir()
  logger = new FakeLogger()
  store = new FsMemoryStore({ stateDir: state.dir, logger, maxProjectBytes: 8 * 1024 })
})
afterEach(async () => {
  await state.cleanup()
})

const quarantined = async () =>
  (await readdir(join(state.dir, 'memory', 'quarantine')).catch(() => [])).sort()

async function plant(content: string | Buffer): Promise<void> {
  await mkdir(join(state.dir, 'memory'), { recursive: true })
  await writeFile(fileFor(state.dir, PROJECT), content)
}

describe('FsMemoryStore: formato en disco', () => {
  it('guarda JSON versión 1 en <estado>/memory/<hash>.json y no deja temporales', async () => {
    await store.update(PROJECT, add('hola'))
    const names = await readdir(join(state.dir, 'memory'))
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
    const raw = JSON.parse(await readFile(fileFor(state.dir, PROJECT), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.project).toBe(PROJECT)
    expect(ProjectMemory.safeParse(raw).success).toBe(true)
  })

  it('el tope por omisión es de 4 MiB', () => {
    expect(DEFAULT_MAX_PROJECT_BYTES).toBe(4 * 1024 * 1024)
  })

  it('un directorio de estado que es un archivo da error IO, no cuelga ni rompe', async () => {
    await writeFile(join(state.dir, 'archivo'), 'x')
    const broken = new FsMemoryStore({ stateDir: join(state.dir, 'archivo'), logger })
    const read = await broken.load(PROJECT).catch((e: unknown) => e)
    // En POSIX leer bajo un archivo da ENOTDIR (IO); en Windows, ENOENT (registro vacío): ambos valen.
    if (read instanceof MemoryStoreError) expect(read.code).toBe('IO')
    else expect((read as { observations: unknown[] }).observations).toEqual([])
    const write = await broken.update(PROJECT, add('x')).catch((e: unknown) => e)
    expect((write as MemoryStoreError).code).toBe('IO')
    expect(await broken.list()).toEqual([])
  })
})

describe('FsMemoryStore: archivos ilegibles se apartan sin tumbar nada', () => {
  const hostile: [string, string | Buffer][] = [
    ['truncado', '{"version":1,"project":"/work/app","updatedAt":1,"nextSeq":1,"observ'],
    ['vacío', ''],
    ['basura binaria', Buffer.from([0, 255, 254, 1, 2, 3, 0x7b])],
    ['null', 'null'],
    ['número', '42'],
    ['arreglo', '[]'],
    ['cadena', '"hola"'],
    [
      '__proto__',
      '{"__proto__":{"polluted":true},"version":1,"project":"/work/app","updatedAt":1,"nextSeq":1,"observations":[],"reflection":null,"sessions":[],"usage":{"calls":0,"inputTokens":0,"outputTokens":0,"costUsd":0}}',
    ],
    ['claves extra', '{"version":1,"project":"/work/app","extra":1}'],
    ['esquema inválido', '{"version":1,"project":"/work/app","nextSeq":-5}'],
    ['anidado profundo', `${'['.repeat(5000)}${']'.repeat(5000)}`],
  ]

  it.each(hostile)('%s', async (_name, content) => {
    await plant(content)
    const m = await store.load(PROJECT)
    expect(m.observations).toEqual([])
    expect(m.project).toBe(PROJECT)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(await quarantined()).toHaveLength(1)
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true)
    // El proyecto sigue siendo utilizable.
    const saved = await store.update(PROJECT, add('nuevo'))
    expect(saved.observations).toHaveLength(1)
    expect((await store.load(PROJECT)).observations).toHaveLength(1)
  })

  it('una versión futura se aparta con su motivo y no se sobrescribe a ciegas', async () => {
    await plant(JSON.stringify({ version: 2, project: PROJECT, datosNuevos: [1, 2, 3] }))
    expect((await store.load(PROJECT)).observations).toEqual([])
    const [only] = await quarantined()
    expect(only).toContain('.future.')
    const kept = JSON.parse(
      await readFile(join(state.dir, 'memory', 'quarantine', only as string), 'utf8'),
    )
    expect(kept.version).toBe(2)
  })

  it('un archivo de otro proyecto (colisión o manipulación) se aparta', async () => {
    await store.update('/otro', add('de otro'))
    const other = await readFile(fileFor(state.dir, '/otro'), 'utf8')
    await plant(other)
    expect((await store.load(PROJECT)).observations).toEqual([])
    expect((await quarantined())[0]).toContain('.mismatch.')
  })

  it('un archivo gigante no se lee entero: se aparta por tamaño', async () => {
    await plant('x'.repeat(8 * 1024 * 2 + 1))
    expect((await store.load(PROJECT)).observations).toEqual([])
    expect((await quarantined())[0]).toContain('.too-large.')
  })

  it('un directorio donde debería haber un archivo se aparta', async () => {
    await mkdir(fileFor(state.dir, PROJECT), { recursive: true })
    expect((await store.load(PROJECT)).observations).toEqual([])
    expect(await quarantined()).toHaveLength(1)
  })

  it('conserva solo los últimos 20 apartados', async () => {
    for (let i = 0; i < 25; i++) {
      await plant(`{roto ${i}`)
      await store.load(PROJECT)
    }
    expect((await quarantined()).length).toBeLessThanOrEqual(20)
  })

  it('list ignora corruptos y archivos ajenos', async () => {
    await store.update('/bueno', add('x'))
    await plant('{roto')
    await writeFile(join(state.dir, 'memory', 'ajeno.json'), '{}')
    await writeFile(join(state.dir, 'memory', `${'a'.repeat(32)}.json.123.tmp`), 'parcial')
    const listed = await store.list()
    expect(listed.map((p) => p.project)).toEqual(['/bueno'])
    expect(await quarantined()).toEqual([])
  })
})

describe('FsMemoryStore: concurrencia y tope', () => {
  it('dos almacenes (dos procesos) escribiendo a la vez dejan siempre un archivo íntegro', async () => {
    const other = new FsMemoryStore({ stateDir: state.dir, logger })
    const writes: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) {
      writes.push(store.update(PROJECT, add(`a${i}`)).catch(() => {}))
      writes.push(other.update(PROJECT, add(`b${i}`)).catch(() => {}))
    }
    await Promise.all(writes)
    const raw = await readFile(fileFor(state.dir, PROJECT), 'utf8')
    expect(ProjectMemory.safeParse(JSON.parse(raw)).success).toBe(true)
    expect(await quarantined()).toEqual([])
    const names = await readdir(join(state.dir, 'memory'))
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('pasarse del tope no escribe nada y no deja temporales', async () => {
    await store.update(PROJECT, add('uno'))
    const before = await readFile(fileFor(state.dir, PROJECT), 'utf8')
    const error = await store
      .update(PROJECT, add('y'.repeat(1900)))
      .then(() =>
        store.update(PROJECT, (m) =>
          appendObservations(
            m,
            Array.from({ length: 10 }, (_, i) => ({
              at: i,
              priority: 'low' as const,
              scope: 'project' as const,
              sessionId: S1,
              range: { from: 0, to: 0 },
              text: 'z'.repeat(1900),
            })),
            2,
          ),
        ),
      )
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MemoryStoreError)
    expect((error as MemoryStoreError).code).toBe('TOO_LARGE')
    const after = await readFile(fileFor(state.dir, PROJECT), 'utf8')
    expect(after).not.toBe(before) // el primer update (1900 bytes) sí cupo
    expect((await readdir(join(state.dir, 'memory'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('permisos privados en POSIX', async (ctx) => {
    if (process.platform === 'win32') return ctx.skip()
    await store.update(PROJECT, add('x'))
    expect((await stat(join(state.dir, 'memory'))).mode & 0o777).toBe(0o700)
    expect((await stat(fileFor(state.dir, PROJECT))).mode & 0o777).toBe(0o600)
  })
})
