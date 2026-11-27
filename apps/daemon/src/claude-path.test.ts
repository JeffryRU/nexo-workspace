import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type ExecutableFs, findClaudeOnPath, nodeExecutableFs } from './bundle.ts'

const fsWith = (...files: string[]): ExecutableFs => ({ isExecutable: (p) => files.includes(p) })

describe('findClaudeOnPath (Linux)', () => {
  it('devuelve el primer claude ejecutable del PATH', () => {
    const fs = fsWith('/b/claude', '/c/claude')
    expect(findClaudeOnPath({ PATH: '/a:/b:/c' }, 'linux', fs)).toBe('/b/claude')
  })

  it('cae a ~/.local/bin si el PATH no lo tiene', () => {
    const fs = fsWith('/home/ana/.local/bin/claude')
    expect(findClaudeOnPath({ PATH: '/usr/bin', HOME: '/home/ana' }, 'linux', fs)).toBe(
      '/home/ana/.local/bin/claude',
    )
  })

  it('el PATH manda sobre ~/.local/bin', () => {
    const fs = fsWith('/usr/bin/claude', '/home/ana/.local/bin/claude')
    expect(findClaudeOnPath({ PATH: '/usr/bin', HOME: '/home/ana' }, 'linux', fs)).toBe(
      '/usr/bin/claude',
    )
  })

  it('PATH vacío o ausente y sin HOME no encuentra nada', () => {
    const fs = fsWith('claude', '/claude', './claude')
    expect(findClaudeOnPath({ PATH: '' }, 'linux', fs)).toBeUndefined()
    expect(findClaudeOnPath({}, 'linux', fs)).toBeUndefined()
  })
})

describe('findClaudeOnPath (Windows)', () => {
  it('solo acepta claude.exe y busca PATH sin distinguir mayúsculas', () => {
    const fs = fsWith('C:\\Users\\Ana\\bin\\claude.exe', 'C:\\npm\\claude.cmd')
    expect(findClaudeOnPath({ Path: 'C:\\npm;C:\\Users\\Ana\\bin' }, 'win32', fs)).toBe(
      'C:\\Users\\Ana\\bin\\claude.exe',
    )
    expect(findClaudeOnPath({ Path: 'C:\\npm' }, 'win32', fs)).toBeUndefined()
  })

  it('cae a %USERPROFILE%\\.local\\bin', () => {
    const fs = fsWith('C:\\Users\\Ana\\.local\\bin\\claude.exe')
    expect(findClaudeOnPath({ PATH: 'C:\\x', USERPROFILE: 'C:\\Users\\Ana' }, 'win32', fs)).toBe(
      'C:\\Users\\Ana\\.local\\bin\\claude.exe',
    )
  })
})

describe('findClaudeOnPath (adversarial)', () => {
  it('ignora entradas relativas, vacías, con NUL o enormes', () => {
    const seen: string[] = []
    const fs: ExecutableFs = {
      isExecutable: (p) => {
        seen.push(p)
        return false
      },
    }
    const huge = `/${'x'.repeat(5000)}`
    findClaudeOnPath({ PATH: `:.:rel/bin:..:/a\0b:${huge}:/ok` }, 'linux', fs)
    expect(seen).toEqual(['/ok/claude'])
  })

  it('un PATH con miles de entradas se corta y no se cuelga', () => {
    let calls = 0
    const fs: ExecutableFs = {
      isExecutable: () => {
        calls++
        return false
      },
    }
    const path = Array.from({ length: 50_000 }, (_, i) => `/d${i}`).join(':')
    expect(findClaudeOnPath({ PATH: path }, 'linux', fs)).toBeUndefined()
    expect(calls).toBeLessThanOrEqual(256)
  })

  it('no ejecuta ni interpreta nada: un nombre con metacaracteres es solo una ruta', () => {
    const fs = fsWith('/a;rm -rf ~/claude')
    expect(findClaudeOnPath({ PATH: '/a;rm -rf ~' }, 'linux', fs)).toBe('/a;rm -rf ~/claude')
  })
})

describe('nodeExecutableFs (archivos reales)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'claude ñ '))
    dirs.push(d)
    return d
  }

  it('un directorio llamado claude no cuenta', () => {
    const d = tmp()
    mkdirSync(join(d, 'claude'))
    expect(findClaudeOnPath({ PATH: d }, process.platform)).toBeUndefined()
    expect(nodeExecutableFs.isExecutable(join(d, 'claude'))).toBe(false)
  })

  it('un archivo ejecutable cuenta; sin permiso de ejecución no (Unix)', () => {
    const d = tmp()
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
    writeFileSync(join(d, exe), '#!/bin/sh\n')
    if (process.platform === 'win32') {
      expect(findClaudeOnPath({ PATH: d }, 'win32')).toBe(join(d, exe))
      return
    }
    chmodSync(join(d, exe), 0o644)
    expect(findClaudeOnPath({ PATH: d, HOME: '' }, 'linux')).toBeUndefined()
    chmodSync(join(d, exe), 0o755)
    expect(findClaudeOnPath({ PATH: d, HOME: '' }, 'linux')).toBe(join(d, exe))
  })

  it('un enlace roto o una ruta inexistente no cuentan', () => {
    expect(nodeExecutableFs.isExecutable(join(tmp(), 'no-existe', 'claude'))).toBe(false)
  })
})
