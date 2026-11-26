import { join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeResolveFs, type ResolveFs, resolveAgentCommand } from '../src/resolve.ts'

/** Sistema de archivos falso: `files` son rutas existentes (con su texto), sin distinguir `\` de `/` ni mayúsculas. */
const fsOf = (files: Record<string, string> | string[]): ResolveFs => {
  const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase()
  const entries = Array.isArray(files) ? files.map((f) => [f, ''] as const) : Object.entries(files)
  const map = new Map(entries.map(([p, text]) => [norm(p), text]))
  return { isFile: (p) => map.has(norm(p)), readText: (p) => map.get(norm(p)) }
}
const NODE = '/usr/bin/node'

/** El `.cmd` que npm crea para un paquete con `bin` (forma real, con `%dp0%`). */
const BACK = String.fromCharCode(92)
const shim = (script: string) =>
  String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%${BACK}${script}" %*
`

describe('resolveAgentCommand', () => {
  it('Linux: busca el comando en el PATH, lo lanza tal cual y conserva los args del agente', () => {
    const r = resolveAgentCommand({
      command: 'gemini',
      args: ['--acp'],
      env: { PATH: '/nada:/opt/bin' },
      platform: 'linux',
      cwd: '/w',
      fs: fsOf(['/opt/bin/gemini']),
    })
    expect(r).toEqual({ command: '/opt/bin/gemini', args: ['--acp'] })
  })

  it('una ruta explícita manda sobre el PATH; si no existe, error claro con el nombre', () => {
    const fs = fsOf(['/x/mi-agente'])
    expect(
      resolveAgentCommand({
        command: '/x/mi-agente',
        env: { PATH: '' },
        platform: 'linux',
        cwd: '/',
        fs,
      }),
    ).toEqual({ command: '/x/mi-agente', args: [] })
    expect(
      resolveAgentCommand({ command: '/y/otro', env: {}, platform: 'linux', cwd: '/', fs }),
    ).toEqual({ error: 'no existe el ejecutable: /y/otro' })
    expect(
      resolveAgentCommand({
        command: 'gemini',
        env: { PATH: '/a' },
        platform: 'linux',
        cwd: '/',
        fs,
      }),
    ).toEqual({ error: 'no se encontró «gemini» en el PATH' })
  })

  it('un script .js/.mjs se lanza con Node, antes de los args del agente', () => {
    expect(
      resolveAgentCommand({
        command: '/x/agente.mjs',
        args: ['--acp', '-m', 'y'],
        env: {},
        platform: 'linux',
        cwd: '/',
        nodePath: NODE,
        fs: fsOf(['/x/agente.mjs']),
      }),
    ).toEqual({ command: NODE, args: ['/x/agente.mjs', '--acp', '-m', 'y'] })
  })

  it('Windows: prefiere .exe a .cmd y nunca elige el archivo sin extensión de npm', () => {
    const r = resolveAgentCommand({
      command: 'gemini',
      args: ['--acp'],
      env: { Path: 'C:\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\npm\\gemini', 'C:\\npm\\gemini.cmd', 'C:\\npm\\gemini.exe']),
    })
    expect(r).toMatchObject({ args: ['--acp'] })
    expect((r as { command: string }).command.toLowerCase()).toBe('c:\\npm\\gemini.exe')
  })

  it('Windows: un .cmd de npm se resuelve al .js que invoca (leído del shim), sin shell', () => {
    const rel = String.raw`node_modules\@google\gemini-cli\bundle\gemini.js`
    const js = win32.join('C:\\npm', ...rel.split('\\'))
    const r = resolveAgentCommand({
      command: 'gemini',
      args: ['--acp'],
      env: { PATH: 'C:\\npm' },
      platform: 'win32',
      cwd: 'C:\\',
      nodePath: 'C:\\node.exe',
      fs: fsOf({ 'C:\\npm\\gemini': '#!/bin/sh', 'C:\\npm\\gemini.cmd': shim(rel), [js]: '' }),
    })
    expect(r).toEqual({ command: 'C:\\node.exe', args: [js, '--acp'] })
  })

  it('Windows: un .cmd cuyo .js no existe, o ilegible, o que sale de su carpeta, da un error que dice qué hacer', () => {
    const rel = String.raw`node_modules\@google\gemini-cli\bundle\gemini.js`
    const cases: Record<string, string>[] = [
      { 'C:\\npm\\gemini.cmd': shim(rel) },
      { 'C:\\npm\\gemini.cmd': 'sin referencia a ningún script' },
      { 'C:\\npm\\gemini.cmd': shim(String.raw`node_modules\..\..\fuera.js`), 'C:\\fuera.js': '' },
    ]
    for (const files of cases) {
      const r = resolveAgentCommand({
        command: 'gemini',
        env: { PATH: 'C:\\npm' },
        platform: 'win32',
        cwd: 'C:\\',
        fs: fsOf(files),
      })
      expect(r, JSON.stringify(Object.keys(files))).toHaveProperty('error')
      expect((r as { error: string }).error).toMatch(/ruta del \.exe o del \.js/)
    }
    // Sin poder leer el shim.
    const unreadable: ResolveFs = {
      isFile: (p) => p.endsWith('gemini.cmd'),
      readText: () => undefined,
    }
    expect(
      resolveAgentCommand({
        command: 'gemini',
        env: { PATH: 'C:\\npm' },
        platform: 'win32',
        cwd: 'C:\\',
        fs: unreadable,
      }),
    ).toHaveProperty('error')
  })

  it('Windows: una ruta con extensión explícita se usa tal cual y PATH/PATHEXT en minúsculas funcionan', () => {
    const exe = 'C:\\tools\\agente.exe'
    expect(
      resolveAgentCommand({
        command: exe,
        env: {},
        platform: 'win32',
        cwd: 'C:\\',
        fs: fsOf([exe]),
      }),
    ).toEqual({ command: exe, args: [] })
    const r = resolveAgentCommand({
      command: 'agente',
      env: { path: 'C:\\b;C:\\c', pathext: '.cmd;.exe' },
      platform: 'win32',
      cwd: 'C:\\',
      fs: fsOf(['C:\\c\\agente.exe']),
    })
    expect(r).toEqual({ command: 'C:\\c\\agente.exe', args: [] })
  })

  it('las reglas de rutas son las de la plataforma pedida', () => {
    expect(posix.delimiter).toBe(':')
    expect(win32.delimiter).toBe(';')
  })

  it('nodeResolveFs distingue archivos de directorios, lee archivos pequeños y tolera lo que no existe', () => {
    expect(nodeResolveFs.isFile(import.meta.filename)).toBe(true)
    expect(nodeResolveFs.isFile(import.meta.dirname)).toBe(false)
    expect(nodeResolveFs.isFile(join(import.meta.dirname, 'no-existe-xyz'))).toBe(false)
    expect(nodeResolveFs.readText(import.meta.filename)).toContain('nodeResolveFs')
    expect(nodeResolveFs.readText(join(import.meta.dirname, 'no-existe-xyz'))).toBeUndefined()
  })
})
