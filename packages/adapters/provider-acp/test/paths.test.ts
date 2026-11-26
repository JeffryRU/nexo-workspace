import { describe, expect, it } from 'vitest'
import { relativeTo } from '../src/paths.ts'
import { actionDraft } from '../src/translator.ts'

describe('relativeTo', () => {
  it('acorta lo que está dentro de la carpeta y deja lo demás', () => {
    expect(relativeTo('/proyecto', '/proyecto/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/proyecto/', '/proyecto/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/proyecto', '/otro/a.ts')).toBe('/otro/a.ts')
    expect(relativeTo('/proyecto', '/proyecto-2/a.ts')).toBe('/proyecto-2/a.ts')
    expect(relativeTo('/proyecto', '/proyecto')).toBe('/proyecto')
    expect(relativeTo('/proyecto', '/proyecto/')).toBe('/proyecto/')
    expect(relativeTo('/proyecto', 'ya/relativa.ts')).toBe('ya/relativa.ts')
    expect(relativeTo(undefined, '/x/a.ts')).toBe('/x/a.ts')
    expect(relativeTo('', '/x/a.ts')).toBe('/x/a.ts')
    expect(relativeTo('/', '/x/a.ts')).toBe('/x/a.ts')
  })

  it('Windows: separadores y mayúsculas de la unidad no importan', () => {
    expect(relativeTo('C:\\Users\\yo\\app', 'c:\\users\\yo\\app\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('C:\\Users\\yo\\app', 'D:\\otro\\a.ts')).toBe('D:\\otro\\a.ts')
  })
})

describe('rutas de las acciones', () => {
  const fields = {
    toolCallId: 'x',
    title: 'Editar',
    kind: 'edit',
    content: [{ type: 'diff', path: '/proyecto/src/a.ts', oldText: 'a\n', newText: 'b\n' }],
    locations: [{ path: '/proyecto/src/a.ts' }],
  }

  it('con cwd, el bloque y el diff muestran la ruta relativa (a/src/a.ts, no a/proyecto/src/a.ts)', () => {
    const d = actionDraft(fields, '/proyecto')
    expect(d.path).toBe('src/a.ts')
    expect(d.diff?.path).toBe('src/a.ts')
    expect(d.diff?.patch).toContain('--- a/src/a.ts')
    expect(d.diff?.patch).toContain('+++ b/src/a.ts')
    expect(d.diff?.patch).not.toContain('proyecto')
  })

  it('sin cwd o fuera de la carpeta se deja la ruta absoluta', () => {
    expect(actionDraft(fields).path).toBe('/proyecto/src/a.ts')
    expect(actionDraft(fields, '/otra').diff?.patch).toContain('--- a/proyecto/src/a.ts')
  })
})
