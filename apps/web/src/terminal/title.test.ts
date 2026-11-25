import { describe, expect, it } from 'vitest'
import { paneTitle } from './title.ts'

describe('paneTitle', () => {
  it('acorta la ruta de un ejecutable de Windows al nombre corto y conserva la ruta completa', () => {
    const full =
      'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe'
    expect(paneTitle(full)).toEqual({ label: 'pwsh', full })
    expect(paneTitle('C:\\Windows\\System32\\cmd.exe').label).toBe('cmd')
    expect(paneTitle('"C:\\Program Files\\Git\\bin\\bash.exe"').label).toBe('bash')
    expect(paneTitle('c:/tools/nu.EXE').label).toBe('nu')
    expect(paneTitle('\\\\servidor\\share\\app.bat').label).toBe('app')
  })

  it('respeta los títulos puestos por OSC 0/2', () => {
    for (const title of [
      'nexo-workspace',
      'user@host: ~/proyecto',
      '/home/user/proyecto',
      'C:\\Users\\yo>',
      'Administrador: C:\\Windows\\System32\\cmd.exe',
      'C:\\proyecto\\notas.txt',
      'pwsh',
    ]) {
      expect(paneTitle(title)).toEqual({ label: title, full: title })
    }
  })

  it('sanea caracteres de control y no deja etiquetas vacías', () => {
    expect(paneTitle('a\u001b[31mb\u0007c').label).toBe('a [31mb c')
    expect(paneTitle('').label).toBe('')
    expect(paneTitle('C:\\.exe').label).toBe('C:\\.exe')
    expect(paneTitle('  C:\\x\\y.exe\n').label).toBe('y')
  })

  it('un título hostil o enorme no se interpreta ni tarda', () => {
    const hostile = `<img src=x onerror=alert(1)>${'\\'.repeat(50_000)}`
    const t0 = performance.now()
    expect(paneTitle(hostile).full).toContain('<img')
    expect(paneTitle(`C:\\${'a\\'.repeat(100_000)}x.exe`).label).toHaveLength(200_008)
    expect(paneTitle(`C:\\${'a'.repeat(200_000)}`).label).toHaveLength(200_003)
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
