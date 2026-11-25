import { ProviderCapabilities, ProviderEvent, ProviderSessionToken } from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
} from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { sleep } from '../timers.ts'

export type AgentConformanceSubject = {
  provider: AgentProviderPort
  /** Opciones válidas para abrir una sesión (cwd existente, etc.). */
  open: AgentOpenOptions
  prompts: {
    /** Un mensaje que produce una respuesta corta y termina el turno solo. */
    simple: string
    /** Un mensaje cuyo turno no termina hasta que se interrumpe. */
    long: string
    /** Un mensaje que provoca una solicitud de permiso; sin él se omiten esas pruebas. */
    permission?: string
  }
  cleanup?: () => Promise<void> | void
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('tiempo de espera agotado')
    await sleep(5)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  )
}

/**
 * Suite de conformidad de `AgentProviderPort`. Se ejecuta contra el falso (testkit) y contra cada
 * adaptador real (`runAgentProviderConformance('provider-claude', () => ({ ... }))`).
 */
export function runAgentProviderConformance(
  name: string,
  create: () => AgentConformanceSubject,
): void {
  describe(`AgentProviderPort conformance: ${name}`, () => {
    const live: AgentProviderSession[] = []
    let subject: AgentConformanceSubject

    afterEach(async () => {
      for (const s of live.splice(0)) await s.close().catch(() => {})
      await subject.cleanup?.()
    })

    const open = async (options?: AgentOpenOptions) => {
      subject = create()
      const session = await subject.provider.open(options ?? subject.open)
      live.push(session)
      const events: ProviderEvent[] = []
      const raw: unknown[] = []
      session.onEvent((e) => {
        raw.push(e)
        events.push(e)
      })
      return { session, events, raw }
    }
    const turnEnds = (events: ProviderEvent[]) => events.filter((e) => e.type === 'turn-end')

    it('declara identidad y capacidades válidas', async () => {
      subject = create()
      expect(subject.provider.id).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
      expect(subject.provider.displayName.length).toBeGreaterThan(0)
      expect(typeof (await subject.provider.isAvailable())).toBe('boolean')
      const caps = await subject.provider.capabilities()
      expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
      if (subject.open.permissionMode !== undefined) {
        expect(caps.permissionModes).toContain(subject.open.permissionMode)
      }
    })

    it('open devuelve una sesión con ficha válida y estable', async () => {
      const { session } = await open()
      expect(ProviderSessionToken.safeParse(session.providerSessionId).success).toBe(true)
      expect(session.providerSessionId).toBe(session.providerSessionId)
    })

    it('open rechaza con AgentProviderError INVALID_OPTIONS si el cwd está vacío', async () => {
      subject = create()
      const error = await rejection(subject.provider.open({ ...subject.open, cwd: '' }))
      expect(error).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    })

    it('open rechaza una ficha de reanudar desconocida', async () => {
      subject = create()
      const error = await rejection(
        subject.provider.open({ ...subject.open, resume: 'no-existe-xyz' }),
      )
      expect(error).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    })

    it('un turno simple emite eventos válidos, bloques bien formados y un solo turn-end', async () => {
      const { session, events, raw } = await open()
      await session.send(subject.prompts.simple)
      await waitFor(() => turnEnds(events).length > 0)
      await sleep(30)
      expect(turnEnds(events)).toHaveLength(1)
      for (const e of raw) {
        const r = ProviderEvent.safeParse(e)
        expect(r.success, JSON.stringify(e)).toBe(true)
      }
      const opened = new Set<string>()
      const closed = new Set<string>()
      for (const e of events) {
        if (e.type === 'block-start') {
          expect(opened.has(e.ref)).toBe(false)
          opened.add(e.ref)
        } else if (
          e.type === 'block-delta' ||
          e.type === 'block-update' ||
          e.type === 'block-end'
        ) {
          expect(opened.has(e.ref), `bloque sin abrir: ${e.ref}`).toBe(true)
          expect(closed.has(e.ref), `bloque ya cerrado: ${e.ref}`).toBe(false)
          if (e.type === 'block-end') closed.add(e.ref)
        }
      }
      // el turn-end es lo último del turno
      expect(events[events.length - 1]?.type).toBe('turn-end')
    })

    it('send con texto vacío rechaza con INVALID_OPTIONS', async () => {
      const { session } = await open()
      const error = await rejection(session.send(''))
      expect(error).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    })

    it('send con un turno en curso rechaza con BUSY; interrupt lo termina una vez y deja enviar de nuevo', async () => {
      const { session, events } = await open()
      await session.send(subject.prompts.long)
      const busy = await rejection(session.send(subject.prompts.simple))
      expect(busy).toBeInstanceOf(AgentProviderError)
      expect((busy as AgentProviderError).code).toBe('BUSY')
      await session.interrupt()
      await session.interrupt()
      await waitFor(() => turnEnds(events).length > 0)
      await sleep(30)
      const ends = turnEnds(events)
      expect(ends).toHaveLength(1)
      expect(ends[0]).toMatchObject({ stopReason: 'interrupted' })
      await session.send(subject.prompts.simple)
      await waitFor(() => turnEnds(events).length > 1)
      expect(turnEnds(events)).toHaveLength(2)
    })

    it('interrupt sin turno en curso no hace nada ni lanza', async () => {
      const { session, events } = await open()
      await session.interrupt()
      await session.interrupt()
      await sleep(20)
      expect(turnEnds(events)).toHaveLength(0)
    })

    it('onEvent cancelado no recibe más', async () => {
      subject = create()
      const session = await subject.provider.open(subject.open)
      live.push(session)
      let calls = 0
      const unsubscribe = session.onEvent(() => {
        calls++
      })
      unsubscribe()
      await session.send(subject.prompts.simple)
      await sleep(100)
      expect(calls).toBe(0)
    })

    it('close emite exit una vez, es idempotente y luego send rechaza con CLOSED', async () => {
      const { session, events } = await open()
      await session.close()
      await session.close()
      await sleep(30)
      expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
      const error = await rejection(session.send(subject.prompts.simple))
      expect(error).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('CLOSED')
      const after = events.length
      await sleep(30)
      expect(events).toHaveLength(after)
    })

    it('reanudar con la ficha devuelve la misma sesión del proveedor (si lo declara)', async () => {
      const { session } = await open()
      const caps = await subject.provider.capabilities()
      if (!caps.resume) return
      const id = session.providerSessionId
      await session.close()
      const again = await subject.provider.open({ ...subject.open, resume: id })
      live.push(again)
      expect(again.providerSessionId).toBe(id)
    })

    describe('permisos', () => {
      const permissionPrompt = () => subject?.prompts.permission

      const askPermission = async () => {
        const ctx = await open()
        const prompt = permissionPrompt()
        if (prompt === undefined) return null
        await ctx.session.send(prompt)
        await waitFor(() => ctx.events.some((e) => e.type === 'permission-request'))
        const request = ctx.events.find((e) => e.type === 'permission-request')
        if (request?.type !== 'permission-request') throw new Error('sin solicitud')
        return { ...ctx, request }
      }

      it('la solicitud trae opciones y responderla termina el turno', async () => {
        const ctx = await askPermission()
        if (ctx === null) return
        const allow = ctx.request.options.find((o) => o.kind.startsWith('allow'))
        expect(allow).toBeDefined()
        await ctx.session.respond({
          type: 'permission',
          requestId: ctx.request.requestId,
          optionId: allow?.id ?? '',
        })
        await waitFor(() => turnEnds(ctx.events).length > 0)
        expect(turnEnds(ctx.events)).toHaveLength(1)
        const again = await rejection(
          ctx.session.respond({
            type: 'permission',
            requestId: ctx.request.requestId,
            optionId: allow?.id ?? '',
          }),
        )
        expect((again as AgentProviderError).code).toBe('UNKNOWN_REQUEST')
      })

      it('una solicitud desconocida o una opción inexistente se rechazan', async () => {
        const ctx = await askPermission()
        if (ctx === null) return
        const unknown = await rejection(
          ctx.session.respond({ type: 'permission', requestId: 'nope', optionId: 'x' }),
        )
        expect(unknown).toBeInstanceOf(AgentProviderError)
        expect((unknown as AgentProviderError).code).toBe('UNKNOWN_REQUEST')
        const bad = await rejection(
          ctx.session.respond({
            type: 'permission',
            requestId: ctx.request.requestId,
            optionId: 'opción-que-no-existe',
          }),
        )
        expect(bad).toBeInstanceOf(AgentProviderError)
        expect((bad as AgentProviderError).code).toBe('INVALID_OPTIONS')
      })

      it('interrumpir con una solicitud pendiente la cancela y termina el turno', async () => {
        const ctx = await askPermission()
        if (ctx === null) return
        await ctx.session.interrupt()
        await waitFor(() => turnEnds(ctx.events).length > 0)
        expect(ctx.events.some((e) => e.type === 'request-cancelled')).toBe(true)
        expect(turnEnds(ctx.events)[0]).toMatchObject({ stopReason: 'interrupted' })
      })
    })
  })
}
