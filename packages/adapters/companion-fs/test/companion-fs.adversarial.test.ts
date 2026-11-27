import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompanionError } from '@nexo/core'
import { encodeUtf8, tinyCompanion, tinyPng } from '@nexo/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { createFsCompanionPort } from '../src/index.ts'
import { makeRig, type Rig } from './helpers.ts'

const hasControl = (s: string): boolean => [...s].some((c) => (c.codePointAt(0) as number) < 0x20)

let rig: Rig
afterEach(async () => {
  await rig?.cleanup()
})

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CompanionError) return error.code
    throw error
  }
  return 'OK'
}

/** Crear enlaces simbólicos puede necesitar permisos en Windows: si no se puede, la prueba se salta. */
async function trySymlink(target: string, path: string, type?: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch {
    return false
  }
}

describe('companion-fs: enlaces', () => {
  it('un recurso que es un enlace simbólico a un archivo de fuera se rechaza', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    await writeFile(join(rig.outside, 'secreto.png'), tinyPng())
    await rm(join(rig.dir, 'tiny', 'idle.png'))
    if (
      !(await trySymlink(
        join(rig.outside, 'secreto.png'),
        join(rig.dir, 'tiny', 'idle.png'),
        'file',
      ))
    )
      return
    expect(await code(rig.port.get('tiny'))).toBe('INVALID')
    expect(await code(rig.port.readAsset('tiny', 'idle.png'))).toBe('INVALID')
    expect((await rig.port.list()).invalid.map((i) => i.id)).toEqual(['tiny'])
  })

  it('una subcarpeta del paquete que es un enlace a otra carpeta se rechaza', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    await rm(join(rig.dir, 'tiny', 'img'), { recursive: true })
    await mkdir(join(rig.outside, 'img'))
    await writeFile(
      join(rig.outside, 'img', 'think.gif'),
      tinyCompanion()['img/think.gif'] as Uint8Array,
    )
    if (!(await trySymlink(join(rig.outside, 'img'), join(rig.dir, 'tiny', 'img'), 'dir'))) return
    expect(await code(rig.port.readAsset('tiny', 'img/think.gif'))).toBe('INVALID')
  })

  it('un paquete que es un enlace simbólico a una carpeta sale como no válido y no se sirve', async () => {
    rig = await makeRig()
    const real = join(rig.outside, 'real')
    await mkdir(real)
    for (const [rel, bytes] of Object.entries(tinyCompanion({ id: 'enlace' }))) {
      await mkdir(join(real, ...rel.split('/').slice(0, -1)), { recursive: true })
      await writeFile(join(real, ...rel.split('/')), bytes)
    }
    if (!(await trySymlink(real, join(rig.dir, 'enlace'), 'dir'))) return
    const { companions, invalid } = await rig.port.list()
    expect(companions).toEqual([])
    expect(invalid.map((i) => i.id)).toEqual(['enlace'])
    expect(await code(rig.port.get('enlace'))).toBe('INVALID')
    expect(await code(rig.port.readAsset('enlace', 'idle.png'))).toBe('INVALID')
  })

  it('un manifiesto que es un enlace simbólico se rechaza', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    await rm(join(rig.dir, 'tiny', 'companion.json'))
    await writeFile(
      join(rig.outside, 'companion.json'),
      tinyCompanion()['companion.json'] as Uint8Array,
    )
    if (
      !(await trySymlink(
        join(rig.outside, 'companion.json'),
        join(rig.dir, 'tiny', 'companion.json'),
        'file',
      ))
    )
      return
    expect(await code(rig.port.get('tiny'))).toBe('INVALID')
  })

  it('un enlace duro a un archivo de fuera se rechaza', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    await writeFile(join(rig.outside, 'otro.png'), tinyPng())
    await rm(join(rig.dir, 'tiny', 'idle.png'))
    try {
      await link(join(rig.outside, 'otro.png'), join(rig.dir, 'tiny', 'idle.png'))
    } catch {
      return
    }
    expect(await code(rig.port.readAsset('tiny', 'idle.png'))).toBe('INVALID')
  })

  it('la carpeta de datos puede ser un enlace (es del usuario) y los paquetes se leen igual', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    const alias = join(rig.outside, 'alias')
    if (!(await trySymlink(rig.dir, alias, 'dir'))) return
    const port = createFsCompanionPort({ dir: alias })
    expect((await port.list()).companions.map((c) => c.id)).toEqual(['tiny'])
    expect((await port.readAsset('tiny', 'idle.png')).mime).toBe('image/png')
  })
})

describe('companion-fs: rutas y manifiestos hostiles', () => {
  it('sin carpeta de datos no hay compañeros ni errores', async () => {
    rig = await makeRig()
    const port = createFsCompanionPort({ dir: join(rig.outside, 'no-existe') })
    expect(await port.list()).toEqual({ companions: [], invalid: [] })
    expect(await code(port.get('tiny'))).toBe('NOT_FOUND')
  })

  it('rutas del manifiesto con .., absolutas, UNC, unidad, flujos y nombres de Windows no cargan', async () => {
    rig = await makeRig()
    const paths = [
      '../fuera.png',
      '/etc/x.png',
      'C:/x.png',
      '\\\\srv\\share\\x.png',
      'a/../../x.png',
      'idle.png::$DATA',
      'CON.png',
      'a/aux.png',
      'idle.png.',
      'idle.png ',
      `${'x'.repeat(200)}.png`,
      'a/b/c/d/e.png',
    ]
    for (const [i, path] of paths.entries()) {
      const id = `h${i}`
      await rig.put(id, {
        ...tinyCompanion({ id }),
        'companion.json': encodeUtf8(
          JSON.stringify({
            ...JSON.parse(new TextDecoder().decode(tinyCompanion({ id })['companion.json'])),
            states: { idle: { src: path } },
          }),
        ),
      })
    }
    const { companions, invalid } = await rig.port.list()
    expect(companions).toEqual([])
    expect(invalid).toHaveLength(paths.length)
  })

  it('un manifiesto enorme, binario o con claves extra se rechaza sin colgarse', async () => {
    rig = await makeRig()
    await rig.put('grande', { 'companion.json': encodeUtf8(`{"x":"${'a'.repeat(70_000)}"}`) })
    await rig.put('binario', { 'companion.json': Uint8Array.from([0xff, 0xfe, 0, 1, 2, 3]) })
    await rig.put('extra', tinyCompanion({ id: 'extra', manifest: { script: 'alert(1)' } }))
    await rig.put('proto', { 'companion.json': encodeUtf8('{"__proto__":{"x":1},"id":"proto"}') })
    const { companions, invalid } = await rig.port.list()
    expect(companions).toEqual([])
    expect(invalid.map((i) => i.id).sort()).toEqual(['binario', 'extra', 'grande', 'proto'])
  })

  it('nombres de carpeta hostiles no rompen el listado ni cuelan caracteres de control', async () => {
    rig = await makeRig()
    await mkdir(join(rig.dir, 'bad\u001b[31mname'), { recursive: true }).catch(() => {})
    await mkdir(join(rig.dir, '.oculta'), { recursive: true })
    await writeFile(join(rig.dir, 'suelto.txt'), 'x')
    const { companions, invalid } = await rig.port.list()
    expect(companions).toEqual([])
    for (const i of invalid) expect(hasControl(i.id)).toBe(false)
    expect(invalid.some((i) => i.id === '.oculta')).toBe(false)
  })

  it('un recurso que crece o se reemplaza por una carpeta no se sirve', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    await rm(join(rig.dir, 'tiny', 'idle.png'))
    await mkdir(join(rig.dir, 'tiny', 'idle.png'))
    expect(await code(rig.port.readAsset('tiny', 'idle.png'))).toBe('INVALID')
  })

  it('lecturas concurrentes del mismo paquete dan el mismo resultado', async () => {
    rig = await makeRig()
    await rig.put('tiny', tinyCompanion())
    const all = await Promise.all(Array.from({ length: 25 }, () => rig.port.get('tiny')))
    for (const d of all) expect(d).toEqual(all[0])
  })
})
