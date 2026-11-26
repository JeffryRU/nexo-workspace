import { Pane, type PaneId } from '@nexo/contracts'
import { createHarness, FakeFileSystem, RecordingEventBus, SequentialIds } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from './dispatcher.ts'
import { FileService } from './file-service.ts'
import { LayoutService, viewerTitle } from './layout-service.ts'
import { FileSystemError, type FileSystemPort } from './ports/file-system.ts'

function setup() {
  const bus = new RecordingEventBus()
  const service = new LayoutService({ ids: new SequentialIds(), bus })
  const ws = service.createWorkspace('p', '/work')
  const tab = service.createTab(ws.id)
  return { bus, service, first: tab.panes[0]?.id as PaneId }
}

describe('panel viewer', () => {
  it('se crea con su ruta y se titula con el nombre del archivo', () => {
    const { service, first } = setup()
    const pane = service.split(first, 'row', 'viewer', undefined, '/work/docs/LEEME.md')
    expect(pane).toMatchObject({
      kind: 'viewer',
      viewerPath: '/work/docs/LEEME.md',
      title: 'LEEME.md',
    })
    expect(Pane.safeParse(pane).success).toBe(true)
  })

  it('sin ruta es un visor vacío con título por omisión', () => {
    const { service, first } = setup()
    const pane = service.split(first, 'column', 'viewer')
    expect(pane.viewerPath).toBeUndefined()
    expect(pane.title).toBe('Visor')
  })

  it('`path` con otro kind es INVALID_PARAMS', () => {
    const { service, first } = setup()
    expect(() => service.split(first, 'row', 'terminal', undefined, '/a')).toThrow(
      /solo vale con kind viewer/,
    )
  })

  it('viewer.open cambia la ruta y el título y emite layout.changed', () => {
    const { bus, service, first } = setup()
    const pane = service.split(first, 'row', 'viewer', undefined, '/work/a.md')
    const before = bus.ofType('layout.changed').length
    const next = service.openViewer(pane.id, 'C:\\work\\b\\foto.png')
    expect(next).toMatchObject({ viewerPath: 'C:\\work\\b\\foto.png', title: 'foto.png' })
    expect(bus.ofType('layout.changed').length).toBe(before + 1)
    expect(service.paneContext(pane.id)?.pane.viewerPath).toBe('C:\\work\\b\\foto.png')
  })

  it('viewer.open sobre un panel que no es visor es CONFLICT y sobre uno inexistente NOT_FOUND', () => {
    const { service, first } = setup()
    expect(() => service.openViewer(first, '/a')).toThrow(/no es un visor/)
    expect(() => service.openViewer('nada' as PaneId, '/a')).toThrow()
  })

  it('viewerTitle limpia controles, corta y tiene alternativa', () => {
    expect(viewerTitle('/a/b/c.txt')).toBe('c.txt')
    expect(viewerTitle('C:\\a\\b\\c d.txt')).toBe('c d.txt')
    expect(viewerTitle('/a/b/')).toBe('b')
    expect(viewerTitle('/a/x\u001b[31my\u2028z')).toBe('x [31my z')
    expect(viewerTitle('/')).toBe('Visor')
    expect(viewerTitle(`/${'n'.repeat(500)}`).length).toBe(120)
  })

  it('por el protocolo: pane.split con kind viewer y viewer.open', async () => {
    const h = createHarness()
    const { workspace } = await h.workspaces.create({ name: 'p', cwd: '/w' })
    const { tab } = h.workspaces.createTab({ workspaceId: workspace.id })
    const first = tab.panes[0]?.id as PaneId
    const out = await h.dispatch({
      method: 'pane.split',
      params: { paneId: first, direction: 'row', kind: 'viewer', path: '/w/a.md' },
    })
    expect(out).toMatchObject({
      ok: true,
      result: { pane: { kind: 'viewer', viewerPath: '/w/a.md' } },
    })
    if (!out.ok) throw new Error('fallo')
    const open = await h.dispatch({
      method: 'viewer.open',
      params: { paneId: out.result.pane.id, path: '/w/b.md' },
    })
    expect(open).toMatchObject({
      ok: true,
      result: { pane: { viewerPath: '/w/b.md', title: 'b.md' } },
    })
    const bad = await h.dispatch({
      method: 'pane.split',
      params: { paneId: first, direction: 'row', path: '/w/a.md' },
    })
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } })
  })
})

describe('FileService y fs.* en el despachador', () => {
  const fake = new FakeFileSystem(['/work'])
  fake.setFile('/work/a.md', '# hola')
  fake.setFile('/work/.ssh/id_rsa', 'x')

  const dispatcherWith = (files?: FileService) => {
    const h = createHarness()
    return createDispatcher({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => ({ seq: 0 }),
      shutdown: () => {},
      ...(files === undefined ? {} : { files: files.handlers }),
    })
  }

  it('sin servicio de archivos responde PROVIDER_UNAVAILABLE', async () => {
    const dispatch = dispatcherWith()
    expect(await dispatch({ method: 'fs.stat', params: { path: '/work/a.md' } })).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_UNAVAILABLE' },
    })
    expect(await dispatch({ method: 'fs.read', params: { path: '/work/a.md' } })).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_UNAVAILABLE' },
    })
  })

  it('con servicio, stat y read van al puerto', async () => {
    const dispatch = dispatcherWith(new FileService(fake))
    expect(await dispatch({ method: 'fs.stat', params: { path: '/work/a.md' } })).toMatchObject({
      ok: true,
      result: { type: 'markdown', size: 6 },
    })
    expect(await dispatch({ method: 'fs.read', params: { path: '/work/a.md' } })).toMatchObject({
      ok: true,
      result: { data: '# hola', eof: true },
    })
  })

  it('traduce cada error del puerto a su código del protocolo', async () => {
    const expected: [string, string][] = [
      ['INVALID_PATH', 'INVALID_PARAMS'],
      ['INVALID_RANGE', 'INVALID_PARAMS'],
      ['NOT_A_FILE', 'INVALID_PARAMS'],
      ['FORBIDDEN', 'FORBIDDEN'],
      ['NOT_FOUND', 'NOT_FOUND'],
      ['TOO_LARGE', 'PAYLOAD_TOO_LARGE'],
      ['CONFLICT', 'CONFLICT'],
      ['IO', 'INTERNAL'],
    ]
    for (const [from, to] of expected) {
      const port: FileSystemPort = {
        stat: async () => {
          throw new FileSystemError(from as never, '/secreto/ruta/interna')
        },
        read: async () => {
          throw new Error('/otra/ruta/interna')
        },
      }
      const dispatch = dispatcherWith(new FileService(port))
      const out = await dispatch({ method: 'fs.stat', params: { path: '/x' } })
      expect(out, from).toMatchObject({ ok: false, error: { code: to } })
      if (!out.ok) expect(out.error.message).not.toContain('interna')
      const inner = await dispatch({ method: 'fs.read', params: { path: '/x' } })
      expect(inner).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'error interno' } })
    }
  })

  it('las rutas sensibles y externas del falso llegan como FORBIDDEN', async () => {
    const dispatch = dispatcherWith(new FileService(fake))
    for (const path of ['/work/.ssh/id_rsa', '/etc/passwd']) {
      expect(await dispatch({ method: 'fs.read', params: { path } })).toMatchObject({
        ok: false,
        error: { code: 'FORBIDDEN' },
      })
    }
  })
})
