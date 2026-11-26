import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeResolveFs, type ResolveFs, resolveCodexCommand } from '../src/resolve.ts'

/** Sistema de archivos falso: `files` son rutas existentes, comparadas sin distinguir `\` de `/` ni mayúsculas. */
const fsOf = (files: string[]): ResolveFs => {
  const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()
  const set = new Set(files.map(norm))
  return { isFile: (p) => set.has(norm(p)) }
}
const NODE = '/usr/bin/node'

describe('resolveCodexCommand', () => {
  it('Linux: busca «codex» en el PATH y lo lanza tal cual', () => {
    const r = resolveCodexCommand({
      env: { PATH: '/nada:/opt/bin' },
      platform: 'linux',
      cwd: '/w',
      fs: fsOf(['/opt/bin/codex']),
    })
    expect(r).toEqual({ command: '/opt/bin/codex', args: [] })
  })

  it('una ruta explícita (NEXO_CODEX_EXECUTABLE) manda sobre el PATH; si no existe, error claro', () => {
    const fs = fsOf(['/x/mi-codex'])
    expect(
      resolveCodexCommand({
        executable: '/x/mi-codex',
        env: { PATH: '' },
        platform: 'linux',
        cwd: '/',
        fs,
      }),
    ).toEqual({ command: '/x/mi-codex', args: [] })
    expect(
      resolveCodexCommand({ executable: '/y/otro', env: {}, platform: 'linux', cwd: '/', fs }),
    ).toEqual({ error: 'no existe el ejecutable de Codex: /y/otro' })
    expect(resolveCodexCommand({ env: { PATH: '/a' }, platform: 'linux', cwd: '/', fs })).toEqual({
      error: 'no se encontró «codex» en el PATH',
    })
  })

  it('un script .js/.mjs se lanza con Node', () => {
    expect(
      resolveCodexCommand({
        executable: '/x/codex.js',
        env: {},
        platform: 'linux',
        cwd: '/',
        nodePath: NODE,
        fs: fsOf(['/x/codex.js']),
      }),
    ).toEqual({ command: NODE, args: ['/x/codex.js'] })
  })

  it('Windows: prefiere .exe a .cmd y nunca elige el archivo sin extensión de npm', () => {
    const r = resolveCodexCommand({
      env: { Path: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\npm\\codex', 'C:\\npm\\codex.cmd', 'C:\\npm\\codex.exe']),
    })
    expect(r).toMatchObject({ args: [] })
    // PATHEXT viene en mayúsculas: la extensión elegida es .EXE.
    expect((r as { command: string }).command.toLowerCase()).toBe('c:\\npm\\codex.exe')
  })

  it('Windows: un codex.cmd de npm se resuelve al codex.js que invoca, sin shell', () => {
    const js = win32.join('C:\\npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    const r = resolveCodexCommand({
      env: { PATH: 'C:\\npm' },
      platform: 'win32',
      cwd: 'C:\\',
      nodePath: 'C:\\node.exe',
      fs: fsOf(['C:\\npm\\codex', 'C:\\npm\\codex.cmd', js]),
    })
    expect(r).toEqual({ command: 'C:\\node.exe', args: [js] })
  })

  it('Windows: un .cmd sin su codex.js da un error que dice qué hacer', () => {
    const r = resolveCodexCommand({
      env: { PATH: 'C:\\npm' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\npm\\codex.cmd']),
    })
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toMatch(/NEXO_CODEX_EXECUTABLE/)
  })

  it('Windows: una ruta con extensión explícita se usa tal cual y PATH/PATHEXT en minúsculas funcionan', () => {
    const exe = 'C:\\tools\\codex.exe'
    expect(
      resolveCodexCommand({
        executable: exe,
        env: {},
        platform: 'win32',
        cwd: 'C:\\',
        fs: fsOf([exe]),
      }),
    ).toEqual({ command: exe, args: [] })
    const r = resolveCodexCommand({
      env: { path: 'C:\\b;C:\\c', pathext: '.cmd;.exe' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\c\\codex.exe']),
    })
    expect(r).toEqual({ command: 'C:\\c\\codex.exe', args: [] })
  })

  it('las reglas de rutas son las de la plataforma pedida', () => {
    expect(posix.delimiter).toBe(':')
    expect(win32.delimiter).toBe(';')
  })

  it('nodeResolveFs distingue archivos de directorios y de lo que no existe', () => {
    expect(nodeResolveFs.isFile(import.meta.filename)).toBe(true)
    expect(nodeResolveFs.isFile(import.meta.dirname)).toBe(false)
    expect(nodeResolveFs.isFile(join(import.meta.dirname, 'no-existe-xyz'))).toBe(false)
  })
})
