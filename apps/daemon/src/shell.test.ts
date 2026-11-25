import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findOnPath, resolveDefaultShell } from './shell.ts'

const files =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p)

describe('findOnPath', () => {
  it('busca en el PATH de la plataforma', () => {
    const isFile = files('C:\\bin\\pwsh.exe', '/usr/bin/sh')
    expect(findOnPath('pwsh.exe', { Path: 'C:\\x;C:\\bin' }, 'win32', isFile)).toBe(true)
    expect(findOnPath('pwsh.exe', { PATH: 'C:\\x' }, 'win32', isFile)).toBe(false)
    expect(findOnPath('sh', { PATH: '/bin:/usr/bin' }, 'linux', isFile)).toBe(true)
    expect(findOnPath('sh', {}, 'linux', isFile)).toBe(false)
    expect(findOnPath('sh', { PATH: '::' }, 'linux', isFile)).toBe(false)
  })
})

describe('resolveDefaultShell', () => {
  it('Windows: pwsh.exe si está en el PATH, si no powershell.exe', () => {
    const env = { Path: 'C:\\ps7' }
    expect(
      resolveDefaultShell({ env, platform: 'win32', isFile: files('C:\\ps7\\pwsh.exe') }),
    ).toEqual({ cmd: 'pwsh.exe' })
    expect(resolveDefaultShell({ env, platform: 'win32', isFile: files() })).toEqual({
      cmd: 'powershell.exe',
    })
  })

  it('Linux: $SHELL si existe, si no /bin/sh', () => {
    expect(
      resolveDefaultShell({
        env: { SHELL: '/bin/zsh' },
        platform: 'linux',
        isFile: files('/bin/zsh'),
      }),
    ).toEqual({ cmd: '/bin/zsh' })
    expect(resolveDefaultShell({ env: {}, platform: 'linux', isFile: files() }).cmd).toBe('/bin/sh')
    expect(
      resolveDefaultShell({ env: { SHELL: '' }, platform: 'linux', isFile: files() }).cmd,
    ).toBe('/bin/sh')
  })

  it('NEXO_SHELL manda si existe (ruta absoluta o nombre en el PATH)', () => {
    expect(
      resolveDefaultShell({
        env: { NEXO_SHELL: '/x/fish' },
        platform: 'linux',
        isFile: files('/x/fish'),
      }),
    ).toEqual({ cmd: '/x/fish' })
    expect(
      resolveDefaultShell({
        env: { NEXO_SHELL: 'fish', PATH: '/x' },
        platform: 'linux',
        isFile: files('/x/fish'),
      }),
    ).toEqual({ cmd: 'fish' })
    expect(
      resolveDefaultShell({
        env: { NEXO_SHELL: 'C:\\tools\\fish.exe' },
        platform: 'win32',
        isFile: files('C:\\tools\\fish.exe'),
      }),
    ).toEqual({ cmd: 'C:\\tools\\fish.exe' })
  })
})

describe('findOnPath con el sistema de archivos real', () => {
  it('encuentra archivos, no directorios ni inexistentes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexo-shell-'))
    try {
      writeFileSync(join(dir, 'mi-shell'), '')
      const env = { PATH: dir, Path: dir }
      const platform = process.platform
      expect(findOnPath('mi-shell', env, platform)).toBe(true)
      expect(findOnPath('no-existe', env, platform)).toBe(false)
      expect(findOnPath('.', env, platform)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
