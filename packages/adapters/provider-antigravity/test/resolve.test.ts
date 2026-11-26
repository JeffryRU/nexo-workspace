import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeResolveFs, type ResolveFs, resolveAgyCommand } from '../src/resolve.ts'
import { FAKE } from './helpers.ts'

/** Sistema de archivos falso: `files` son rutas existentes, comparadas sin distinguir `\` de `/` ni mayúsculas. */
const fsOf = (files: string[]): ResolveFs => {
  const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()
  const set = new Set(files.map(norm))
  return { isFile: (p) => set.has(norm(p)) }
}

describe('resolveAgyCommand', () => {
  it('Linux: busca «agy» en el PATH y lo lanza tal cual', () => {
    expect(
      resolveAgyCommand({
        env: { PATH: '/nada:/opt/bin' },
        platform: 'linux',
        cwd: '/w',
        fs: fsOf(['/opt/bin/agy']),
      }),
    ).toEqual({ command: '/opt/bin/agy', args: [] })
  })

  it('una ruta explícita manda sobre el PATH; si no existe, error claro', () => {
    const fs = fsOf(['/x/mi-agy'])
    expect(
      resolveAgyCommand({
        executable: '/x/mi-agy',
        env: { PATH: '' },
        platform: 'linux',
        cwd: '/',
        fs,
      }),
    ).toEqual({ command: '/x/mi-agy', args: [] })
    expect(
      resolveAgyCommand({ executable: '/y/otro', env: {}, platform: 'linux', cwd: '/', fs }),
    ).toEqual({
      error: 'no existe el ejecutable de agy: /y/otro',
    })
    expect(resolveAgyCommand({ env: { PATH: '/a' }, platform: 'linux', cwd: '/', fs })).toEqual({
      error: 'no se encontró «agy» en el PATH',
    })
  })

  it('un script .js/.mjs se lanza con Node', () => {
    expect(
      resolveAgyCommand({
        executable: '/x/agy.mjs',
        env: {},
        platform: 'linux',
        cwd: '/',
        nodePath: '/usr/bin/node',
        fs: fsOf(['/x/agy.mjs']),
      }),
    ).toEqual({ command: '/usr/bin/node', args: ['/x/agy.mjs'] })
  })

  it('Windows: prueba .exe antes que .cmd y respeta PATHEXT sin distinguir mayúsculas', () => {
    const fs = fsOf(['C:\\u\\agy.cmd', 'C:\\u\\agy.exe', 'C:\\v\\agy.exe'])
    expect(
      resolveAgyCommand({
        env: { Path: 'C:\\u;C:\\v', pathext: '.CMD;.EXE' },
        platform: 'win32',
        cwd: 'C:\\',
        fs,
      }),
    ).toEqual({ command: 'C:\\u\\agy.EXE', args: [] })
  })

  it('Windows: un .cmd no se puede lanzar sin shell y pide agy.exe', () => {
    const r = resolveAgyCommand({
      env: { PATH: 'C:\\u' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\u\\agy.cmd']),
    })
    expect(r).toHaveProperty('error')
    expect((r as { error: string }).error).toContain('NEXO_AGY_EXECUTABLE')
  })

  it('Windows: una ruta con separadores y extensión explícita', () => {
    expect(
      resolveAgyCommand({
        executable: 'C:\\bin\\agy.exe',
        env: {},
        platform: 'win32',
        cwd: 'C:\\',
        fs: fsOf(['C:\\bin\\agy.exe']),
      }),
    ).toEqual({ command: 'C:\\bin\\agy.exe', args: [] })
  })

  it('nodeResolveFs: archivo sí, carpeta y ausente no', () => {
    expect(nodeResolveFs.isFile(FAKE)).toBe(true)
    expect(nodeResolveFs.isFile(join(FAKE, '..'))).toBe(false)
    expect(nodeResolveFs.isFile(join(FAKE, 'no-existe'))).toBe(false)
  })
})
