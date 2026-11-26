import { spawnSync } from 'node:child_process'
import {
  appendFile,
  mkdir,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join, parse } from 'node:path'
import { LIMITS } from '@nexo/contracts'
import { FileSystemError } from '@nexo/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FsSandbox } from '../src/index.ts'
import { makeRig, type Rig } from './helpers.ts'

const win = process.platform === 'win32'

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof FileSystemError) return error.code
    throw error
  }
  return 'OK'
}

/** En Windows crear enlaces simbólicos puede exigir privilegios: sin ellos la prueba se omite con un aviso. */
async function link(
  target: string,
  path: string,
  type?: 'file' | 'dir' | 'junction',
): Promise<boolean> {
  try {
    await symlink(target, path, type)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

let rig: Rig
beforeEach(async () => {
  rig = await makeRig()
})
afterEach(async () => {
  await rig.cleanup()
})

describe('enlaces simbólicos', () => {
  it('un enlace de la raíz a un archivo de fuera no se lee', async () => {
    await rig.put(rig.outside('secreto.txt'), 'fuera')
    if (!(await link(rig.outside('secreto.txt'), rig.inside('atajo.txt'), 'file'))) return
    expect(await code(rig.sandbox.read({ path: rig.inside('atajo.txt') }))).toBe('FORBIDDEN')
    expect(await code(rig.sandbox.stat(rig.inside('atajo.txt')))).toBe('FORBIDDEN')
  })

  it('un enlace de carpeta que sale de la raíz tampoco', async () => {
    await rig.put(rig.outside('d/secreto.txt'), 'fuera')
    if (!(await link(rig.outsideDir, rig.inside('salida'), 'junction'))) return
    expect(
      await code(rig.sandbox.read({ path: join(rig.inside('salida'), 'd', 'secreto.txt') })),
    ).toBe('FORBIDDEN')
    expect(await code(rig.sandbox.stat(rig.inside('salida')))).toBe('FORBIDDEN')
  })

  it('un enlace hacia un archivo sensible dentro de la raíz se bloquea', async () => {
    await rig.put(rig.inside('.ssh/id_rsa'), 'clave')
    if (!(await link(rig.inside('.ssh/id_rsa'), rig.inside('inocente.txt'), 'file'))) return
    expect(await code(rig.sandbox.read({ path: rig.inside('inocente.txt') }))).toBe('FORBIDDEN')
  })

  it('un enlace dentro de la raíz sí se lee y se informa la ruta real', async () => {
    await rig.put(rig.inside('real.txt'), 'hola')
    if (!(await link(rig.inside('real.txt'), rig.inside('alias.txt'), 'file'))) return
    const r = await rig.sandbox.read({ path: rig.inside('alias.txt') })
    expect(r.data).toBe('hola')
    expect(r.path).toBe(rig.inside('real.txt'))
  })

  it('enlaces en bucle son una ruta inválida, no un cuelgue', async () => {
    if (!(await link(rig.inside('b'), rig.inside('a'), 'dir'))) return
    await link(rig.inside('a'), rig.inside('b'), 'dir')
    expect(await code(rig.sandbox.stat(rig.inside('a')))).toBe('INVALID_PATH')
    expect(await code(rig.sandbox.read({ path: join(rig.inside('a'), 'x.txt') }))).toBe(
      'INVALID_PATH',
    )
  })

  it('un enlace colgante dentro de la raíz es NOT_FOUND y fuera de ella FORBIDDEN', async () => {
    if (!(await link(rig.inside('no-hay'), rig.inside('colgante'), 'file'))) return
    expect(await code(rig.sandbox.stat(rig.inside('colgante')))).toBe('NOT_FOUND')
  })

  it('la raíz puede ser un enlace: se resuelve y lo de dentro se lee', async () => {
    await rig.put(rig.inside('a.txt'), 'a')
    const alias = join(rig.outsideDir, 'alias-raiz')
    if (!(await link(rig.root, alias, 'junction'))) return
    rig.roots.splice(0, rig.roots.length, alias)
    expect((await rig.sandbox.read({ path: join(alias, 'a.txt') })).data).toBe('a')
  })
})

describe('raíces', () => {
  it('sin raíces no se lee nada', async () => {
    await rig.put(rig.inside('a.txt'), 'a')
    rig.roots.length = 0
    expect(await code(rig.sandbox.stat(rig.inside('a.txt')))).toBe('FORBIDDEN')
  })

  it('una carpeta hermana con el mismo prefijo no cuenta como dentro', async () => {
    await rig.put(`${rig.root}-hermana${win ? '\\' : '/'}a.txt`, 'a')
    expect(
      await code(rig.sandbox.read({ path: `${rig.root}-hermana${win ? '\\' : '/'}a.txt` })),
    ).toBe('FORBIDDEN')
  })

  it('la raíz de una unidad o del sistema no se acepta como raíz', async () => {
    await rig.put(rig.outside('a.txt'), 'a')
    rig.roots.splice(0, rig.roots.length, parse(rig.root).root)
    expect(await code(rig.sandbox.read({ path: rig.outside('a.txt') }))).toBe('FORBIDDEN')
  })

  it('una raíz relativa, inexistente o sensible se ignora', async () => {
    await rig.put(rig.inside('a.txt'), 'a')
    await rig.put(rig.inside('.ssh/k'), 'k')
    rig.roots.splice(0, rig.roots.length, 'relativa', rig.inside('no-existe'), rig.inside('.ssh'))
    expect(await code(rig.sandbox.stat(rig.inside('a.txt')))).toBe('FORBIDDEN')
    expect(await code(rig.sandbox.stat(rig.inside('.ssh/k')))).toBe('FORBIDDEN')
  })

  it('las raíces se consultan en cada llamada (espacios que se abren y se cierran)', async () => {
    await rig.put(rig.outside('a.txt'), 'a')
    expect(await code(rig.sandbox.stat(rig.outside('a.txt')))).toBe('FORBIDDEN')
    rig.roots.push(rig.outsideDir)
    expect(await code(rig.sandbox.stat(rig.outside('a.txt')))).toBe('OK')
    rig.roots.length = 0
    expect(await code(rig.sandbox.stat(rig.outside('a.txt')))).toBe('FORBIDDEN')
  })

  it('una función de raíces asíncrona vale', async () => {
    await rig.put(rig.inside('a.txt'), 'a')
    const sandbox = new FsSandbox({ roots: async () => [rig.root] })
    expect((await sandbox.read({ path: rig.inside('a.txt') })).data).toBe('a')
  })

  it('una política de rutas sensibles propia se respeta', async () => {
    await rig.put(rig.inside('secreto.txt'), 'a')
    await rig.put(rig.inside('.ssh/k'), 'k')
    const sandbox = new FsSandbox({
      roots: () => [rig.root],
      isSensitive: (segments) => segments.includes('secreto.txt'),
    })
    expect(await code(sandbox.stat(rig.inside('secreto.txt')))).toBe('FORBIDDEN')
    expect(await code(sandbox.stat(rig.inside('.ssh/k')))).toBe('OK')
  })
})

describe('rutas hostiles de Windows, también fuera de Windows', () => {
  const hostile = [
    '\\\\servidor\\recurso\\a.txt',
    '//servidor/recurso/a.txt',
    '\\\\?\\C:\\work\\a.txt',
    '\\\\.\\C:\\work\\a.txt',
    '\\??\\C:\\work\\a.txt',
    'C:work\\a.txt',
    'C:a.txt',
    '\\work\\a.txt',
    'C:\\work\\CON',
    'C:\\work\\nul.txt',
    'C:\\work\\COM1.log',
    'C:\\work\\LPT9',
    'C:\\work\\aux .md',
    'C:\\work\\a.txt:secreto',
    'C:\\work\\a.txt::$DATA',
    'C:\\work\\a.txt.',
    'C:\\work\\a.txt ',
    'C:\\work\\..\\a.txt',
    'C:\\work\\..\\..\\Windows\\win.ini',
    'C:\\work\\a<b>.txt',
    'C:\\work\\a*.txt',
    'C:\\work\\a?.txt',
    'C:\\work\\a|b',
    'C:\\work\\"a"',
  ]
  it('se rechazan por sintaxis sin tocar el disco', async () => {
    const sandbox = new FsSandbox({ roots: () => ['C:\\work'], platform: 'win32' })
    for (const path of hostile) {
      expect([path, await code(sandbox.stat(path))]).toEqual([path, 'INVALID_PATH'])
      expect([path, await code(sandbox.read({ path }))]).toEqual([path, 'INVALID_PATH'])
    }
  })

  it('con las reglas de Linux, una ruta de Windows no es absoluta', async () => {
    const sandbox = new FsSandbox({ roots: () => [rig.root], platform: 'linux' })
    for (const path of ['C:\\work\\a.txt', '\\\\srv\\x\\a', '\\\\?\\C:\\a']) {
      expect(await code(sandbox.stat(path))).toBe('INVALID_PATH')
    }
  })

  it.runIf(win)(
    'en Windows de verdad: dispositivos, flujos y mayúsculas de carpetas sensibles',
    async () => {
      await rig.put(rig.inside('a.txt'), 'a')
      await rig.put(rig.inside('.ssh/k'), 'k')
      for (const rel of ['CON', 'nul.txt', 'COM1', 'a.txt:flujo', 'a.txt.']) {
        expect([rel, await code(rig.sandbox.stat(`${rig.root}\\${rel}`))]).toEqual([
          rel,
          'INVALID_PATH',
        ])
      }
      expect(await code(rig.sandbox.stat(`${rig.root}\\.SSH\\k`))).toBe('FORBIDDEN')
      expect(await code(rig.sandbox.stat(`${rig.root.toUpperCase()}\\A.TXT`))).toBe('OK')
      expect(await code(rig.sandbox.stat(`\\\\?\\${rig.root}\\a.txt`))).toBe('INVALID_PATH')
    },
  )

  it.runIf(win)(
    'en Windows de verdad: un nombre corto 8.3 de una carpeta sensible se resuelve y bloquea',
    async () => {
      await rig.put(rig.inside('.gnupg/clave'), 'k')
      const short = spawnSync('cmd.exe', ['/c', 'dir', '/x', '/a:d', rig.root], {
        encoding: 'utf8',
      })
      const match = /(\S+)\s+\.gnupg/i.exec(short.stdout)
      if (match?.[1] === undefined || !match[1].includes('~')) return
      expect(await code(rig.sandbox.stat(`${rig.root}\\${match[1]}\\clave`))).toBe('FORBIDDEN')
    },
  )
})

describe.runIf(!win)('archivos que no son regulares (Linux/macOS)', () => {
  it('un FIFO se rechaza sin colgar', async () => {
    const fifo = rig.inside('tuberia')
    const made = spawnSync('mkfifo', [fifo])
    if (made.status !== 0) return
    const started = Date.now()
    expect(await code(rig.sandbox.stat(fifo))).toBe('NOT_A_FILE')
    expect(await code(rig.sandbox.read({ path: fifo }))).toBe('NOT_A_FILE')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('un enlace a un dispositivo de caracteres queda fuera de la raíz', async () => {
    if (!(await link('/dev/zero', rig.inside('cero'), 'file'))) return
    expect(await code(rig.sandbox.read({ path: rig.inside('cero') }))).toBe('FORBIDDEN')
    expect(await code(rig.sandbox.read({ path: '/dev/zero' }))).toBe('FORBIDDEN')
    expect(await code(rig.sandbox.read({ path: '/proc/self/environ' }))).toBe('FORBIDDEN')
  })

  it('con /dev como raíz tampoco se lee un dispositivo', async () => {
    rig.roots.splice(0, rig.roots.length, '/dev')
    expect(await code(rig.sandbox.read({ path: '/dev/zero' }))).toBe('NOT_A_FILE')
  })
})

describe('archivos enormes', () => {
  it('uno disperso de 200 MiB se informa pero no se lee', async () => {
    const path = rig.inside('disperso.bin')
    await rig.put(path, '')
    await truncate(path, 200 * 1024 * 1024)
    const st = await rig.sandbox.stat(path)
    expect([st.type, st.tooLarge, st.size]).toEqual(['binary', true, 200 * 1024 * 1024])
    expect(await code(rig.sandbox.read({ path, offset: 5 * 1024 * 1024 }))).toBe('TOO_LARGE')
  })

  it('un archivo justo en el tope se lee por trozos hasta el final', async () => {
    const path = rig.inside('tope.bin')
    await rig.put(path, Uint8Array.from([1]))
    await truncate(path, LIMITS.maxFsBinaryBytes)
    let offset = LIMITS.maxFsBinaryBytes - 10
    const r = await rig.sandbox.read({ path, offset, length: 100 })
    expect([r.length, r.eof]).toEqual([10, true])
    offset = 0
    const first = await rig.sandbox.read({ path, offset })
    expect(first.length).toBe(LIMITS.maxFsChunkBytes)
  })

  it('un archivo que se acorta entre la lectura de la firma y la del trozo es CONFLICT', async () => {
    const path = rig.inside('cambia.txt')
    await rig.put(path, 'a'.repeat(2000))
    const racing = new FsSandbox({ roots: () => [rig.root] })
    // Acorta el archivo en cuanto se pide la lectura: el trozo ya no cabe.
    const original = racing.read.bind(racing)
    const promise = original({ path, offset: 1000, length: 1000 })
    await truncate(path, 1500).catch(() => {})
    const outcome = await code(promise)
    expect(['OK', 'CONFLICT']).toContain(outcome)
  })
})

describe('carreras', () => {
  it.runIf(!win)(
    'cambiar un archivo por un enlace hacia fuera durante muchas lecturas nunca filtra',
    async () => {
      const target = rig.inside('objetivo.txt')
      const secret = rig.outside('secreto.txt')
      await rig.put(secret, 'TOP-SECRET'.repeat(50))
      await rig.put(rig.inside('base.txt'), 'inocente'.repeat(50))
      await rig.put(target, 'inocente'.repeat(50))
      let stop = false
      const swapper = (async () => {
        let flip = false
        while (!stop) {
          const tmp = rig.inside('tmp-swap')
          await rm(tmp, { force: true })
          if (flip) await symlink(secret, tmp)
          else await writeFile(tmp, 'inocente'.repeat(50))
          await rename(tmp, target).catch(() => {})
          flip = !flip
          await new Promise((r) => setImmediate(r))
        }
      })()
      const leaked: string[] = []
      const outcomes = new Set<string>()
      for (let i = 0; i < 300; i++) {
        try {
          const r = await rig.sandbox.read({ path: target })
          if (r.data.includes('TOP-SECRET')) leaked.push(r.data.slice(0, 20))
          outcomes.add('OK')
        } catch (error) {
          if (!(error instanceof FileSystemError)) throw error
          outcomes.add(error.code)
        }
      }
      stop = true
      await swapper
      expect(leaked).toEqual([])
      for (const o of outcomes)
        expect(['OK', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'NOT_A_FILE']).toContain(o)
    },
  )

  it('un archivo que crece mientras se lee no rompe el contrato', async () => {
    const path = rig.inside('crece.txt')
    await rig.put(path, 'x'.repeat(100))
    const grower = (async () => {
      for (let i = 0; i < 50; i++) {
        await appendFile(path, 'y'.repeat(100))
        await new Promise((r) => setImmediate(r))
      }
    })()
    for (let i = 0; i < 50; i++) {
      const outcome = await rig.sandbox.read({ path }).then(
        (r) => r.length <= r.size,
        (e: unknown) => e instanceof FileSystemError && e.code === 'CONFLICT',
      )
      expect(outcome).toBe(true)
    }
    await grower
  })

  it('un archivo que desaparece entre la comprobación y la lectura es NOT_FOUND o CONFLICT', async () => {
    const path = rig.inside('efimero.txt')
    await rig.put(path, 'hola')
    const tasks = Array.from({ length: 40 }, async () => {
      const outcome = await code(rig.sandbox.read({ path }))
      return outcome
    })
    await unlink(path)
    for (const o of await Promise.all(tasks)) expect(['OK', 'NOT_FOUND', 'CONFLICT']).toContain(o)
  })

  it('muchas lecturas en paralelo devuelven cada una lo suyo', async () => {
    await mkdir(rig.inside('p'), { recursive: true })
    for (let i = 0; i < 20; i++) await writeFile(rig.inside(`p/${i}.txt`), `archivo ${i}`)
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) => rig.sandbox.read({ path: rig.inside(`p/${i}.txt`) })),
    )
    expect(all.map((r) => r.data)).toEqual(Array.from({ length: 20 }, (_, i) => `archivo ${i}`))
  })
})

describe('contenido hostil', () => {
  it('un SVG con scripts se informa como svg y se entrega como datos, sin interpretarlo', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    await rig.put(rig.inside('x.svg'), svg)
    const r = await rig.sandbox.read({ path: rig.inside('x.svg') })
    expect([r.type, r.data]).toEqual(['svg', svg])
  })

  it('un PDF o PNG truncado o con basura se informa tal cual', async () => {
    await rig.put(rig.inside('t.pdf'), '%PDF-')
    await rig.put(rig.inside('t.png'), Uint8Array.from([0x89, 0x50]))
    expect((await rig.sandbox.stat(rig.inside('t.pdf'))).type).toBe('pdf')
    expect((await rig.sandbox.stat(rig.inside('t.png'))).type).toBe('binary')
  })

  it('bytes UTF-8 inválidos tras el principio no rompen la lectura de texto', async () => {
    const head = Buffer.from('a'.repeat(9000))
    await rig.put(rig.inside('mixto.txt'), Buffer.concat([head, Buffer.from([0xc3, 0x28, 0xff])]))
    const r = await rig.sandbox.read({ path: rig.inside('mixto.txt'), offset: 8999, length: 100 })
    expect(r.eof).toBe(true)
    expect(r.data).toContain('\ufffd')
  })
})
