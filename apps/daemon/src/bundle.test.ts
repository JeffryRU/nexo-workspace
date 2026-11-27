import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { bundledClaudeExecutable, defaultWebRoot, isBundled } from './bundle.ts'

const norm = (p: string | undefined) => p?.replaceAll('\\', '/')
const pkg = pathToFileURL('/opt/Nexo Ñandú/daemon/daemon.mjs').href
const repo = pathToFileURL('/repo/apps/daemon/src/daemon.ts').href

describe('bundle', () => {
  it('distingue el repositorio (.ts) del paquete', () => {
    expect(isBundled(repo)).toBe(false)
    expect(isBundled(pkg)).toBe(true)
  })

  it('la web está en apps/web/dist o en web/ del paquete', () => {
    expect(norm(defaultWebRoot(repo))).toMatch(/\/repo\/apps\/web\/dist$/)
    expect(norm(defaultWebRoot(pkg))).toMatch(/\/opt\/Nexo Ñandú\/web$/)
  })

  it('el Claude del paquete es vendor/claude (claude.exe en Windows) y solo si existe', () => {
    const seen: string[] = []
    const yes = (p: string) => {
      seen.push(p)
      return true
    }
    expect(norm(bundledClaudeExecutable(pkg, 'linux', yes))).toMatch(/Nexo Ñandú\/vendor\/claude$/)
    expect(norm(bundledClaudeExecutable(pkg, 'win32', yes))).toMatch(
      /Nexo Ñandú\/vendor\/claude\.exe$/,
    )
    expect(bundledClaudeExecutable(pkg, 'linux', () => false)).toBeUndefined()
  })

  it('en el repositorio nunca busca un Claude empaquetado', () => {
    expect(bundledClaudeExecutable(repo, 'linux', () => true)).toBeUndefined()
  })
})
