import { LIMITS, type Observation, ProjectMemory } from '@nexo/contracts'
import {
  appendObservations,
  emptyProjectMemory,
  MemoryStoreError,
  type MemoryStorePort,
} from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'

export type MemoryStoreConformanceSubject = {
  store: MemoryStorePort
  /** Tope de bytes por proyecto con el que se creó el almacén; sin él se omite la prueba de `TOO_LARGE`. */
  maxBytes?: number
  cleanup?: () => Promise<void> | void
}

const obs = (n: number, text = `observación ${n}`): Omit<Observation, 'seq'> => ({
  at: n,
  priority: 'medium',
  scope: 'project',
  sessionId: 's1' as Observation['sessionId'],
  range: { from: 0, to: 1 },
  text,
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

/** Suite de conformidad de `MemoryStorePort`: la ejecutan el falso (testkit) y cada adaptador real. */
export function runMemoryStoreConformance(
  name: string,
  create: () => Promise<MemoryStoreConformanceSubject> | MemoryStoreConformanceSubject,
): void {
  describe(`MemoryStorePort conformance: ${name}`, () => {
    let subject: MemoryStoreConformanceSubject
    afterEach(async () => {
      await subject?.cleanup?.()
    })
    const setup = async () => {
      subject = await create()
      return subject.store
    }
    const add = (n: number) => (m: ProjectMemory) => appendObservations(m, [obs(n)], n)

    it('un proyecto sin registro devuelve uno vacío y válido', async () => {
      const store = await setup()
      const m = await store.load('/work/nuevo')
      expect(ProjectMemory.safeParse(m).success).toBe(true)
      expect(m.project).toBe('/work/nuevo')
      expect(m.observations).toEqual([])
      expect(await store.list()).toEqual([])
    })

    it('update guarda, load lo devuelve y el resultado es una copia', async () => {
      const store = await setup()
      const saved = await store.update('/work/app', add(1))
      expect(saved.observations).toHaveLength(1)
      const loaded = await store.load('/work/app')
      expect(loaded).toEqual(saved)
      loaded.observations.length = 0
      expect((await store.load('/work/app')).observations).toHaveLength(1)
    })

    it('la clave es la carpeta normalizada: Windows sin distinguir mayúsculas ni separadores', async () => {
      const store = await setup()
      await store.update('C:\\Work\\App', add(1))
      for (const same of [
        'c:/work/app',
        'C:/WORK/App/',
        'c:\\work\\.\\app\\',
        'C:\\Work\\x\\..\\App',
      ]) {
        expect((await store.load(same)).observations, same).toHaveLength(1)
      }
      expect((await store.load('c:/work/other')).observations).toHaveLength(0)
      expect((await store.list()).map((p) => p.project)).toEqual(['c:/work/app'])
    })

    it('en POSIX las mayúsculas distinguen proyectos', async () => {
      const store = await setup()
      await store.update('/Work/App', add(1))
      expect((await store.load('/work/app')).observations).toHaveLength(0)
      expect((await store.load('/Work/App/')).observations).toHaveLength(1)
    })

    it('update concurrentes se serializan y no pierden cambios', async () => {
      const store = await setup()
      await Promise.all(Array.from({ length: 25 }, (_, i) => store.update('/work/app', add(i))))
      const m = await store.load('/work/app')
      expect(m.observations).toHaveLength(25)
      expect(m.observations.map((o) => o.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    })

    it('proyectos distintos no se mezclan al escribir a la vez', async () => {
      const store = await setup()
      await Promise.all([
        ...Array.from({ length: 8 }, (_, i) => store.update('/a', add(i))),
        ...Array.from({ length: 5 }, (_, i) => store.update('/b', add(i))),
      ])
      expect((await store.load('/a')).observations).toHaveLength(8)
      expect((await store.load('/b')).observations).toHaveLength(5)
    })

    it('si change lanza no se guarda nada y el error sale tal cual; la cola sigue viva', async () => {
      const store = await setup()
      await store.update('/work/app', add(1))
      const boom = new Error('boom')
      const failed = await rejection(
        store.update('/work/app', () => {
          throw boom
        }),
      )
      expect(failed).toBe(boom)
      expect((await store.load('/work/app')).observations).toHaveLength(1)
      await store.update('/work/app', add(2))
      expect((await store.load('/work/app')).observations).toHaveLength(2)
    })

    it('rechaza con INVALID un resultado que cambia de proyecto o no cumple el esquema', async () => {
      const store = await setup()
      await store.update('/work/app', add(1))
      const moved = await rejection(store.update('/work/app', (m) => ({ ...m, project: '/otro' })))
      expect(moved).toBeInstanceOf(MemoryStoreError)
      expect((moved as MemoryStoreError).code).toBe('INVALID')
      const bad = await rejection(
        store.update('/work/app', (m) => ({ ...m, nextSeq: 0 }) as ProjectMemory),
      )
      expect((bad as MemoryStoreError).code).toBe('INVALID')
      expect((await store.load('/work/app')).observations).toHaveLength(1)
    })

    it('rechaza con TOO_LARGE lo que pasa del tope y deja intacto lo anterior', async (ctx) => {
      const store = await setup()
      const cap = subject.maxBytes
      if (cap === undefined) return ctx.skip()
      await store.update('/work/app', add(1))
      const big = 'x'.repeat(LIMITS.maxObservationBytes - 10)
      const many = Math.min(
        LIMITS.maxObservationsPerProject,
        Math.ceil(cap / LIMITS.maxObservationBytes) + 2,
      )
      const error = await rejection(
        store.update('/work/app', (m) =>
          appendObservations(
            m,
            Array.from({ length: many }, (_, i) => obs(i, big)),
            9,
          ),
        ),
      )
      expect(error).toBeInstanceOf(MemoryStoreError)
      expect((error as MemoryStoreError).code).toBe('TOO_LARGE')
      expect((await store.load('/work/app')).observations).toHaveLength(1)
    })

    it('nombres de proyecto raros funcionan como cualquier otro', async () => {
      const store = await setup()
      const names = [
        '__proto__',
        'constructor',
        '/work/__proto__',
        '/work/con espacios y ñ 日本語',
        `/work/${'a'.repeat(300)}`,
        '/work/..%2f..%2fetc',
        'C:\\con\\NUL',
        '\\\\servidor\\Recurso\\Carpeta',
      ]
      for (const [i, n] of names.entries()) await store.update(n, add(i + 1))
      for (const [i, n] of names.entries()) {
        const m = await store.load(n)
        expect(m.observations[0]?.at, n).toBe(i + 1)
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect((await store.list()).length).toBe(names.length)
    })

    it('remove es idempotente y list refleja los proyectos', async () => {
      const store = await setup()
      await store.update('/a', add(1))
      await store.update('/b', add(1))
      const listed = await store.list()
      expect(listed.map((p) => p.project).sort()).toEqual(['/a', '/b'])
      expect(listed.every((p) => p.observations === 1 && p.bytes > 0)).toBe(true)
      await store.remove('/a')
      await store.remove('/a')
      await store.remove('/nunca-existio')
      expect((await store.list()).map((p) => p.project)).toEqual(['/b'])
      expect(emptyProjectMemory('/a', 0).observations).toEqual(
        (await store.load('/a')).observations,
      )
    })
  })
}
