import { describe, expect, it } from 'vitest'
import { resolveDefaultShell } from './shell.ts'

const none = () => false
const only =
  (...p: string[]) =>
  (x: string) =>
    p.includes(x)

describe('resolveDefaultShell (adversarial)', () => {
  it('NEXO_SHELL inexistente: cae al shell del sistema y avisa', () => {
    const r = resolveDefaultShell({
      env: { NEXO_SHELL: '/no/existe', SHELL: '/bin/zsh' },
      platform: 'linux',
      isFile: only('/bin/zsh'),
    })
    expect(r.cmd).toBe('/bin/zsh')
    expect(r.warning).toContain('/no/existe')
  })

  it('NEXO_SHELL vacío o solo espacios se ignora sin aviso', () => {
    for (const v of ['', '   ', '\t\n']) {
      const r = resolveDefaultShell({ env: { NEXO_SHELL: v }, platform: 'linux', isFile: none })
      expect(r).toEqual({ cmd: '/bin/sh' })
    }
  })

  it('ruta con espacios se respeta entera', () => {
    const p = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
    expect(
      resolveDefaultShell({ env: { NEXO_SHELL: p }, platform: 'win32', isFile: only(p) }),
    ).toEqual({ cmd: p })
  })

  it('con argumentos ("pwsh -NoLogo") no se separa: no existe, cae y avisa', () => {
    const r = resolveDefaultShell({
      env: { NEXO_SHELL: '/bin/sh -c evil', PATH: '/bin' },
      platform: 'linux',
      isFile: only('/bin/sh'),
    })
    expect(r.cmd).toBe('/bin/sh')
    expect(r.warning).toBeDefined()
  })

  it('rutas relativas con separadores no se aceptan', () => {
    for (const v of ['./sh', '..\\x\\pwsh.exe', 'bin/sh']) {
      const r = resolveDefaultShell({
        env: { NEXO_SHELL: v },
        platform: 'linux',
        isFile: () => true,
      })
      expect(r.warning).toBeDefined()
    }
  })

  it('$SHELL relativo, inexistente u hostil cae a /bin/sh', () => {
    for (const v of ['zsh', '../../x', '/no/existe', 'a\0b']) {
      expect(resolveDefaultShell({ env: { SHELL: v }, platform: 'linux', isFile: none }).cmd).toBe(
        '/bin/sh',
      )
    }
  })

  it('valores enormes no rompen', () => {
    const r = resolveDefaultShell({
      env: { NEXO_SHELL: 'x'.repeat(100_000), PATH: '/bin' },
      platform: 'linux',
      isFile: none,
    })
    expect(r.cmd).toBe('/bin/sh')
  })
})
