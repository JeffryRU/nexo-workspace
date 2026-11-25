import {
  ERROR_CODES,
  methods,
  type PaneId,
  type TabId,
  type TerminalId,
  type WorkspaceId,
} from '@nexo/contracts'
import { createHarness } from '@nexo/testkit'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { DispatchRequest } from './dispatcher.ts'
import { leaves } from './layout.ts'

type Op = { kind: number; a: number; b: number; c: number; text: string }

const arbOp: fc.Arbitrary<Op> = fc.record({
  kind: fc.integer({ min: 0, max: 19 }),
  a: fc.nat(1000),
  b: fc.nat(1000),
  c: fc.nat(1000),
  text: fc.oneof(
    fc.string({ unit: 'grapheme', maxLength: 30 }),
    fc.constantFrom('\x1b]0;título\x07', '\x1b]2;x\x1b\\', '😀', '\ud83d', '\ude00', 'línea\r\n'),
  ),
})

function pick<T>(items: readonly T[], i: number): T | undefined {
  return items.length === 0 ? undefined : items[i % items.length]
}

describe('despachador (propiedades)', () => {
  it('secuencias aleatorias de operaciones mantienen las invariantes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbOp, { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 4, max: 200 }),
        async (ops, ring) => {
          const h = createHarness({
            config: {
              ringCapacityBytes: ring,
              maxTerminals: 5,
              writeRate: { maxWrites: 4, windowMs: 50 },
            },
          })
          const lastOffset = new Map<TerminalId, number>()
          const lastReadOffset = new Map<TerminalId, number>()

          const state = () => {
            const workspaces = h.layout.snapshot()
            const tabs = workspaces.flatMap((w) => w.tabs.map((t) => ({ w, t })))
            const panes = tabs.flatMap(({ t }) => t.panes)
            return { workspaces, tabs, panes }
          }

          const call = async (req: DispatchRequest) => {
            const out = await h.dispatch(req)
            if (out.ok) {
              const schema = methods[req.method].result
              expect(schema.safeParse(out.result).success).toBe(true)
            } else {
              expect(ERROR_CODES).toContain(out.error.code)
              expect(out.error.code).not.toBe('INTERNAL')
            }
            return out
          }

          const check = () => {
            const { workspaces, tabs, panes } = state()
            // El snapshot siempre valida con el esquema de resultado.
            expect(methods.snapshot.result.parse(h.snapshot.snapshot())).toBeDefined()
            expect(methods['workspace.list'].result.safeParse({ workspaces }).success).toBe(true)
            const paneIds = new Set(panes.map((p) => p.id))
            expect(paneIds.size).toBe(panes.length)
            for (const { t } of tabs) {
              expect(new Set(leaves(t.layout))).toEqual(new Set(t.panes.map((p) => p.id)))
              expect(t.panes.some((p) => p.id === t.focusedPaneId)).toBe(true)
            }
            const listed = h.terminals.list()
            const alivePerPane = new Map<PaneId, number>()
            for (const term of listed) {
              // No hay terminales sin panel y el panel apunta a su terminal.
              const pane = panes.find((p) => p.id === term.paneId)
              expect(pane?.terminalId).toBe(term.terminalId)
              if (term.state !== 'exited') {
                alivePerPane.set(term.paneId, (alivePerPane.get(term.paneId) ?? 0) + 1)
              }
            }
            for (const n of alivePerPane.values()) expect(n).toBe(1)
            expect(new Set(listed.map((x) => x.paneId)).size).toBe(listed.length)
            expect(listed.filter((x) => x.state !== 'exited').length).toBeLessThanOrEqual(5)
            for (const p of panes) {
              if (p.terminalId !== undefined) {
                expect(listed.some((x) => x.terminalId === p.terminalId)).toBe(true)
              }
            }
            // Offsets de salida monótonos por terminal.
            for (const e of h.bus.ofType('terminal.output')) {
              expect(e.offset).toBeGreaterThanOrEqual(lastOffset.get(e.terminalId) ?? 0)
              lastOffset.set(e.terminalId, e.offset)
            }
            h.bus.events.length = 0
          }

          for (const op of ops) {
            const { workspaces, tabs, panes } = state()
            const ws = pick(workspaces, op.a)
            const tab = pick(tabs, op.a)
            const pane = pick(panes, op.a)
            const other = pick(panes, op.b)
            const term = pick(h.terminals.list(), op.a)
            const proc = pick(h.pty.processes, op.a)
            const ghostWs = 'fantasma' as WorkspaceId
            const ghostTab = 'fantasma' as TabId
            const ghostPane = 'fantasma' as PaneId
            switch (op.kind) {
              case 0:
                await call({ method: 'workspace.create', params: { name: 'w' } })
                break
              case 1:
                await call({
                  method: 'workspace.close',
                  params: { workspaceId: ws?.id ?? ghostWs },
                })
                break
              case 2:
                await call({
                  method: 'workspace.rename',
                  params: { workspaceId: ws?.id ?? ghostWs, name: 'n' },
                })
                break
              case 3:
                await call({
                  method: 'tab.create',
                  params: { workspaceId: ws?.id ?? ghostWs },
                })
                break
              case 4:
                await call({ method: 'tab.close', params: { tabId: tab?.t.id ?? ghostTab } })
                break
              case 5:
                await call({
                  method: 'tab.move',
                  params: {
                    tabId: tab?.t.id ?? ghostTab,
                    index: op.b % 5,
                    ...(op.c % 2 === 0
                      ? { workspaceId: pick(workspaces, op.c)?.id ?? ghostWs }
                      : {}),
                  },
                })
                break
              case 6:
                await call({
                  method: 'pane.split',
                  params: {
                    paneId: pane?.id ?? ghostPane,
                    direction: op.b % 2 === 0 ? 'row' : 'column',
                    kind: op.c % 4 === 0 ? 'agent' : 'terminal',
                  },
                })
                break
              case 7:
              case 8:
                await call({ method: 'pane.close', params: { paneId: pane?.id ?? ghostPane } })
                break
              case 9:
                await call({
                  method: 'pane.swap',
                  params: { paneId: pane?.id ?? ghostPane, otherPaneId: other?.id ?? ghostPane },
                })
                break
              case 10:
                await call({
                  method: 'pane.resize',
                  params: { paneId: pane?.id ?? ghostPane, delta: (op.b % 21) / 10 - 1 },
                })
                break
              case 11:
              case 12:
                await call({
                  method: 'terminal.spawn',
                  params: { paneId: pane?.id ?? ghostPane, cols: 80, rows: 24 },
                })
                break
              case 13:
                await call({
                  method: 'terminal.write',
                  params: {
                    terminalId: term?.terminalId ?? ('x' as TerminalId),
                    data: op.text || 'a',
                  },
                })
                break
              case 14:
                await call({
                  method: 'terminal.resize',
                  params: {
                    terminalId: term?.terminalId ?? ('x' as TerminalId),
                    cols: 1 + (op.b % 200),
                    rows: 5,
                  },
                })
                break
              case 15: {
                const r = await call({
                  method: 'terminal.read',
                  params: {
                    terminalId: term?.terminalId ?? ('x' as TerminalId),
                    ...(op.b % 2 === 0 ? { fromOffset: op.c } : {}),
                    ...(op.c % 3 === 0 ? { maxBytes: 1 + (op.b % 50) } : {}),
                  },
                })
                if (r.ok && term !== undefined) {
                  const offset = (r.result as { offset: number }).offset
                  expect(offset).toBeGreaterThanOrEqual(lastReadOffset.get(term.terminalId) ?? 0)
                  lastReadOffset.set(term.terminalId, offset)
                }
                break
              }
              case 16:
                await call({
                  method: 'terminal.kill',
                  params: { terminalId: term?.terminalId ?? ('x' as TerminalId) },
                })
                break
              case 17:
                proc?.emitData(op.text)
                break
              case 18:
                proc?.exit({ exitCode: op.b % 3 })
                break
              default:
                h.clock.advance(op.b % 30)
            }
            check()
          }
          // Al cerrar todos los espacios no queda ninguna terminal.
          for (const w of h.layout.snapshot()) {
            await h.dispatch({ method: 'workspace.close', params: { workspaceId: w.id } })
          }
          expect(h.terminals.list()).toEqual([])
        },
      ),
      { numRuns: 150 },
    )
  })

  it('tras cerrar todo, ningún proceso falso queda vivo', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 5 }),
        async (splits) => {
          const h = createHarness()
          const ws = (await h.dispatch({ method: 'workspace.create', params: { name: 'w' } })) as {
            ok: true
            result: { workspace: { id: WorkspaceId } }
          }
          const tab = h.workspaces.createTab({ workspaceId: ws.result.workspace.id }).tab
          const ids: PaneId[] = [tab.panes[0]?.id as PaneId]
          for (const s of splits) {
            const target = ids[s % ids.length] as PaneId
            ids.push(
              h.workspaces.split({ paneId: target, direction: s % 2 ? 'row' : 'column' }).pane.id,
            )
          }
          for (const id of ids) await h.terminals.spawn({ paneId: id, cols: 80, rows: 24 })
          h.workspaces.close({ workspaceId: ws.result.workspace.id })
          expect(h.pty.processes.every((p) => p.exited !== undefined)).toBe(true)
          expect(h.terminals.list()).toEqual([])
        },
      ),
      { numRuns: 30 },
    )
  })
})
