import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeEnv, toExit } from '../src/node-pty-port.ts'
import { isDirectory, readEnv, resolveExecutable } from '../src/resolve.ts'
import { IS_WINDOWS } from './helpers.ts'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nexo-res-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('mergeEnv', () => {
  it('las claves de env ganan y se descartan los undefined', () => {
    expect(mergeEnv({ A: '1', B: undefined, C: '3' }, { A: '9', D: '4' }, 'linux')).toEqual({
      A: '9',
      C: '3',
      D: '4',
    })
  })
  it('en Windows las claves no distinguen mayúsculas', () => {
    expect(mergeEnv({ Path: 'x', Other: '1' }, { PATH: 'y' }, 'win32')).toEqual({
      PATH: 'y',
      Other: '1',
    })
  })
  it('en Linux distingue mayúsculas', () => {
    expect(mergeEnv({ Path: 'x' }, { PATH: 'y' }, 'linux')).toEqual({ Path: 'x', PATH: 'y' })
  })
  it('sin env devuelve una copia', () => {
    expect(mergeEnv({ A: '1' }, undefined, 'linux')).toEqual({ A: '1' })
  })
})

describe('toExit', () => {
  it('normaliza señales y códigos', () => {
    expect(toExit({ exitCode: 3 })).toEqual({ exitCode: 3, signal: null })
    expect(toExit({ exitCode: 0, signal: 0 })).toEqual({ exitCode: 0, signal: null })
    expect(toExit({ exitCode: 0, signal: 9 })).toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(toExit({ exitCode: 0, signal: 9999 })).toEqual({ exitCode: null, signal: 'SIG9999' })
  })
})

describe('resolveExecutable / readEnv / isDirectory', () => {
  it('readEnv: Windows ignora mayúsculas, Linux no', () => {
    expect(readEnv({ Path: 'a' }, 'PATH', 'win32')).toBe('a')
    expect(readEnv({ Path: 'a' }, 'PATH', 'linux')).toBeUndefined()
    expect(readEnv({}, 'PATH', 'win32')).toBeUndefined()
  })

  it('isDirectory distingue directorios, archivos e inexistentes', () => {
    const d = tmp()
    writeFileSync(join(d, 'f'), '')
    expect(isDirectory(d)).toBe(true)
    expect(isDirectory(join(d, 'f'))).toBe(false)
    expect(isDirectory(join(d, 'nada'))).toBe(false)
  })

  it('busca en PATH con extensiones PATHEXT (modelo Windows)', () => {
    const d = tmp()
    writeFileSync(join(d, 'herramienta.EXE'), '')
    const env = { PATH: d, PATHEXT: '.COM;.EXE' }
    expect(resolveExecutable('herramienta', { cwd: d, env, platform: 'win32' })).toBe(
      join(d, 'herramienta.EXE'),
    )
    expect(resolveExecutable('otra', { cwd: d, env, platform: 'win32' })).toBeUndefined()
  })

  it('usa PATHEXT por defecto y rutas con separador (modelo Windows)', () => {
    const d = tmp()
    writeFileSync(join(d, 'x.CMD'), '')
    expect(resolveExecutable('x', { cwd: d, env: { PATH: '' }, platform: 'win32' })).toBeUndefined()
    expect(resolveExecutable('./x', { cwd: d, env: {}, platform: 'win32' })).toBe(join(d, 'x.CMD'))
  })

  it('no resuelve directorios como ejecutables ni con PATH vacío', () => {
    const d = tmp()
    mkdirSync(join(d, 'dir'))
    expect(
      resolveExecutable('dir', { cwd: d, env: { PATH: d }, platform: 'linux' }),
    ).toBeUndefined()
    expect(resolveExecutable('x', { cwd: d, env: {}, platform: 'linux' })).toBeUndefined()
  })

  it('PATH relativo se resuelve contra cwd y las rutas relativas con separador también', () => {
    const d = tmp()
    mkdirSync(join(d, 'bin'))
    writeFileSync(join(d, 'bin', 'tool'), '')
    if (!IS_WINDOWS) chmodSync(join(d, 'bin', 'tool'), 0o755)
    const platform = process.platform
    const env = { PATH: ['bin', join(d, 'nope')].join(delimiter), PATHEXT: '' }
    expect(resolveExecutable('tool', { cwd: d, env, platform })).toBe(join(d, 'bin', 'tool'))
    expect(resolveExecutable('./bin/tool', { cwd: d, env: {}, platform })).toBe(
      join(d, 'bin', 'tool'),
    )
  })

  it.skipIf(IS_WINDOWS)('en Linux exige el bit de ejecución', () => {
    const d = tmp()
    writeFileSync(join(d, 'noexec'), '')
    chmodSync(join(d, 'noexec'), 0o644)
    expect(
      resolveExecutable('noexec', { cwd: d, env: { PATH: d }, platform: 'linux' }),
    ).toBeUndefined()
  })
})

// Alias de ejecución de la Tienda (p. ej. pwsh.exe instalado desde Microsoft Store): statSync falla con EACCES.
const STORE_ALIAS_DIR = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps')
const hasStoreAlias = (() => {
  if (!IS_WINDOWS) return false
  try {
    return lstatSync(join(STORE_ALIAS_DIR, 'pwsh.exe')).isFile() === false
  } catch {
    return false
  }
})()

describe('alias de ejecución de Windows', () => {
  it.skipIf(!hasStoreAlias)(
    'resolveExecutable encuentra pwsh.exe aunque sea un punto de reanálisis',
    () => {
      const found = resolveExecutable('pwsh.exe', {
        cwd: tmp(),
        env: { PATH: STORE_ALIAS_DIR },
        platform: 'win32',
      })
      expect(found?.toLowerCase()).toBe(join(STORE_ALIAS_DIR, 'pwsh.exe').toLowerCase())
    },
  )
})
