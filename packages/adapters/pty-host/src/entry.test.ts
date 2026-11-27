import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HOST_ENTRY, hostEntryFor } from './supervisor.ts'

const norm = (p: string) => p.replaceAll('\\', '/')

describe('hostEntryFor', () => {
  it('en el repositorio usa host.ts', () => {
    expect(norm(DEFAULT_HOST_ENTRY)).toMatch(/pty-host\/src\/host\.ts$/)
  })

  it('en el paquete usa pty-host.mjs junto al bundle, con espacios y no ASCII', () => {
    const url = pathToFileURL('/opt/Nexo Ñandú/daemon/daemon.mjs').href
    expect(norm(hostEntryFor(url))).toMatch(/\/opt\/Nexo Ñandú\/daemon\/pty-host\.mjs$/)
  })

  it('un módulo sin extensión .ts se trata como paquete (nunca apunta a un .ts inexistente)', () => {
    expect(hostEntryFor(pathToFileURL('/x/daemon.js').href)).toMatch(/pty-host\.mjs$/)
    expect(hostEntryFor(`${pathToFileURL('/x/daemon.mjs').href}?v=1`)).toMatch(/pty-host\.mjs$/)
  })
})
