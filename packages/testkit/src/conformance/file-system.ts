import { LIMITS } from '@nexo/contracts'
import { FileSystemError, type FileSystemPort } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeBase64, encodeUtf8 } from '../bytes.ts'
import { sleep } from '../timers.ts'

export type FileSystemConformanceSubject = {
  fs: FileSystemPort
  /** Ruta absoluta de `rel` (con `/`) dentro de la única carpeta permitida, que empieza vacía. */
  inside(rel: string): string
  /** Ruta absoluta de `rel` fuera de toda carpeta permitida. */
  outside(rel: string): string
  /** Crea o reemplaza un archivo (y sus carpetas). */
  put(path: string, content: string | Uint8Array): Promise<void>
  cleanup?: () => Promise<void> | void
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0])
const GIF = Uint8Array.from([...encodeUtf8('GIF89a'), 1, 0, 1, 0, 0, 0])
const WEBP = Uint8Array.from([...encodeUtf8('RIFF'), 4, 0, 0, 0, ...encodeUtf8('WEBPVP8 ')])
const PDF = encodeUtf8('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n')
const SVG =
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof FileSystemError) return error.code
    throw error
  }
  return 'OK'
}

/**
 * Suite de conformidad de `FileSystemPort`: la ejecutan el falso (testkit) y `FsSandbox`. Cubre el contrato
 * común (tipos, rangos, codificaciones, topes, rechazos); lo propio del disco (enlaces simbólicos, carreras,
 * FIFO, Windows) va en las pruebas adversariales del adaptador.
 */
export function runFileSystemConformance(
  name: string,
  create: () => Promise<FileSystemConformanceSubject> | FileSystemConformanceSubject,
): void {
  describe(`FileSystemPort conformance: ${name}`, () => {
    let subject: FileSystemConformanceSubject
    afterEach(async () => {
      await subject?.cleanup?.()
    })
    const setup = async () => {
      subject = await create()
      return subject
    }

    it('stat de una carpeta no trae tipo', async () => {
      const s = await setup()
      await s.put(s.inside('sub/a.txt'), 'x')
      const st = await s.fs.stat(s.inside('sub'))
      expect(st.kind).toBe('directory')
      expect(st.type).toBeUndefined()
    })

    it('detecta el tipo por firma y extensión', async () => {
      const s = await setup()
      const cases: [string, string | Uint8Array, string, string][] = [
        ['a.md', '# Título\n\nhola', 'markdown', 'text/markdown'],
        ['b.txt', 'hola ñandú 🎉', 'text', 'text/plain'],
        ['c.png', PNG, 'png', 'image/png'],
        ['d.jpg', JPEG, 'jpeg', 'image/jpeg'],
        ['e.gif', GIF, 'gif', 'image/gif'],
        ['f.webp', WEBP, 'webp', 'image/webp'],
        ['g.svg', SVG, 'svg', 'image/svg+xml'],
        ['h.pdf', PDF, 'pdf', 'application/pdf'],
        ['i.bin', Uint8Array.from([0, 1, 2, 3, 0xff]), 'binary', 'application/octet-stream'],
        ['vacio.txt', '', 'text', 'text/plain'],
        // La firma manda sobre la extensión, y la extensión no convierte texto en lo que no es.
        ['falso.png', 'esto no es un PNG', 'text', 'text/plain'],
        ['disfrazado.txt', PNG, 'png', 'image/png'],
        ['no-svg.svg', 'hola, soy texto', 'text', 'text/plain'],
        ['cita.md', 'véase %PDF-1.4 en el texto', 'markdown', 'text/markdown'],
        ['raro.txt', Uint8Array.from([0xc3, 0x28, 0x41]), 'binary', 'application/octet-stream'],
      ]
      for (const [file, content, type, mime] of cases) {
        await s.put(s.inside(file), content)
        const st = await s.fs.stat(s.inside(file))
        expect([file, st.kind, st.type, st.mime]).toEqual([file, 'file', type, mime])
        expect(st.path.endsWith(file)).toBe(true)
        expect(st.size).toBe(
          typeof content === 'string' ? encodeUtf8(content).length : content.length,
        )
        expect(st.tooLarge).toBe(false)
        expect(st.maxBytes).toBeGreaterThan(0)
      }
    })

    it('lee un archivo de texto entero en UTF-8', async () => {
      const s = await setup()
      await s.put(s.inside('n.txt'), 'línea ñ\nsegunda 🎉')
      const r = await s.fs.read({ path: s.inside('n.txt') })
      expect(r.data).toBe('línea ñ\nsegunda 🎉')
      expect(r.encoding).toBe('utf8')
      expect([r.offset, r.eof]).toEqual([0, true])
      expect(r.length).toBe(encodeUtf8('línea ñ\nsegunda 🎉').length)
    })

    it('lee por rangos sin perder ni duplicar bytes y marca el final', async () => {
      const s = await setup()
      const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 251)
      await s.put(s.inside('r.bin'), bytes)
      const out: number[] = []
      let offset = 0
      for (let guard = 0; guard < 100; guard++) {
        const r = await s.fs.read({ path: s.inside('r.bin'), offset, length: 300 })
        expect(r.encoding).toBe('base64')
        expect(r.offset).toBe(offset)
        out.push(...decodeBase64(r.data))
        offset += r.length
        if (r.eof) break
      }
      expect(out).toEqual([...bytes])
      const end = await s.fs.read({ path: s.inside('r.bin'), offset: 1000 })
      expect([end.length, end.data, end.eof]).toEqual([0, '', true])
    })

    it('el texto por rangos nunca parte un carácter', async () => {
      const s = await setup()
      const text = 'añ🎉€x'.repeat(40)
      await s.put(s.inside('u.txt'), text)
      let got = ''
      let offset = 0
      for (let guard = 0; guard < 500; guard++) {
        const r = await s.fs.read({ path: s.inside('u.txt'), offset, length: 5 })
        expect(r.data).not.toContain('�')
        got += r.data
        offset += r.length
        if (r.eof) break
      }
      expect(got).toBe(text)
    })

    it('un offset en medio de un carácter o pasado el final es un rango inválido', async () => {
      const s = await setup()
      await s.put(s.inside('m.txt'), 'ñ')
      expect(await failure(s.fs.read({ path: s.inside('m.txt'), offset: 1 }))).toBe('INVALID_RANGE')
      expect(await failure(s.fs.read({ path: s.inside('m.txt'), offset: 3 }))).toBe('INVALID_RANGE')
    })

    it('respeta los trozos máximos de cada codificación', async () => {
      const s = await setup()
      const big = new Uint8Array(LIMITS.maxFsChunkBytes + 10).fill(0x61)
      await s.put(s.inside('big.txt'), big)
      const text = await s.fs.read({ path: s.inside('big.txt'), length: LIMITS.maxFsChunkBytes })
      expect(text.length).toBe(LIMITS.maxFsTextChunkBytes)
      expect(text.eof).toBe(false)
      const b64 = await s.fs.read({
        path: s.inside('big.txt'),
        length: LIMITS.maxFsChunkBytes,
        encoding: 'base64',
      })
      expect(b64.length).toBe(LIMITS.maxFsChunkBytes)
      expect(JSON.stringify(b64).length).toBeLessThan(LIMITS.maxMessageBytes)
    })

    it('un binario solo se lee en base64', async () => {
      const s = await setup()
      await s.put(s.inside('p.png'), PNG)
      const r = await s.fs.read({ path: s.inside('p.png') })
      expect([r.type, r.encoding]).toEqual(['png', 'base64'])
      expect([...decodeBase64(r.data)]).toEqual([...PNG])
      expect(await failure(s.fs.read({ path: s.inside('p.png'), encoding: 'utf8' }))).toBe(
        'NOT_A_FILE',
      )
    })

    it('el SVG se puede pedir como texto', async () => {
      const s = await setup()
      await s.put(s.inside('v.svg'), SVG)
      const r = await s.fs.read({ path: s.inside('v.svg') })
      expect([r.type, r.encoding, r.data]).toEqual(['svg', 'utf8', SVG])
    })

    it('rechaza un archivo por encima del tope de su tipo', async () => {
      const s = await setup()
      await s.put(s.inside('enorme.txt'), new Uint8Array(LIMITS.maxFsTextBytes + 1).fill(0x61))
      const st = await s.fs.stat(s.inside('enorme.txt'))
      expect([st.tooLarge, st.maxBytes]).toEqual([true, LIMITS.maxFsTextBytes])
      expect(await failure(s.fs.read({ path: s.inside('enorme.txt') }))).toBe('TOO_LARGE')
    })

    it('expectMtimeMs detecta un archivo que cambió entre trozos', async () => {
      const s = await setup()
      await s.put(s.inside('c.txt'), 'uno')
      const first = await s.fs.read({ path: s.inside('c.txt') })
      const same = await s.fs.read({ path: s.inside('c.txt'), expectMtimeMs: first.mtimeMs })
      expect(same.data).toBe('uno')
      await sleep(20)
      await s.put(s.inside('c.txt'), 'dos!')
      expect(
        await failure(s.fs.read({ path: s.inside('c.txt'), expectMtimeMs: first.mtimeMs })),
      ).toBe('CONFLICT')
    })

    it('leer una carpeta no es leer un archivo', async () => {
      const s = await setup()
      await s.put(s.inside('d/x.txt'), 'x')
      expect(await failure(s.fs.read({ path: s.inside('d') }))).toBe('NOT_A_FILE')
    })

    it('un archivo inexistente dentro de la raíz es NOT_FOUND', async () => {
      const s = await setup()
      expect(await failure(s.fs.stat(s.inside('no-existe.txt')))).toBe('NOT_FOUND')
      expect(await failure(s.fs.read({ path: s.inside('x/y/z.txt') }))).toBe('NOT_FOUND')
    })

    it('rechaza rutas mal formadas', async () => {
      const s = await setup()
      await s.put(s.inside('ok.txt'), 'ok')
      const bad = [
        '',
        'relativa/a.txt',
        './a.txt',
        `${s.inside('ok.txt')}\0.png`,
        `${s.inside('sub')}/../ok.txt`,
        `${s.inside('ok.txt')}\n`,
        'x'.repeat(5000),
      ]
      for (const path of bad) {
        expect([path.slice(0, 20), await failure(s.fs.stat(path))]).toEqual([
          path.slice(0, 20),
          'INVALID_PATH',
        ])
      }
    })

    it('rechaza lo que está fuera de las raíces sin revelar si existe', async () => {
      const s = await setup()
      await s.put(s.outside('secreto.txt'), 'fuera')
      expect(await failure(s.fs.stat(s.outside('secreto.txt')))).toBe('FORBIDDEN')
      expect(await failure(s.fs.read({ path: s.outside('secreto.txt') }))).toBe('FORBIDDEN')
      expect(await failure(s.fs.stat(s.outside('no-existe.txt')))).toBe('FORBIDDEN')
    })

    it('bloquea carpetas y archivos sensibles aunque estén dentro de la raíz', async () => {
      const s = await setup()
      const sensitive = [
        '.ssh/id_rsa',
        '.ssh/config',
        '.gnupg/key',
        '.aws/credentials',
        '.claude/.credentials.json',
        '.codex/auth.json',
        '.config/gcloud/creds.json',
        '.git/config',
        '.env',
        '.env.production',
        '.netrc',
        'app/id_ed25519',
        'app/clave.pfx',
        'APP/.SSH/x',
      ]
      for (const rel of sensitive) {
        await s.put(s.inside(rel), 'secreto')
        expect([rel, await failure(s.fs.read({ path: s.inside(rel) }))]).toEqual([rel, 'FORBIDDEN'])
        expect([rel, await failure(s.fs.stat(s.inside(rel)))]).toEqual([rel, 'FORBIDDEN'])
      }
      for (const rel of [
        '.env.example',
        '.gitignore',
        'id_rsa.pub',
        '.github/ci.yml',
        'ssh/notas.md',
      ]) {
        await s.put(s.inside(rel), 'público')
        expect([rel, await failure(s.fs.read({ path: s.inside(rel) }))]).toEqual([rel, 'OK'])
      }
    })

    it('los nombres unicode y con espacios se leen', async () => {
      const s = await setup()
      for (const rel of ['ñandú/ünï cødé.md', 'con espacios/a b.txt', '日本語/ファイル.txt']) {
        await s.put(s.inside(rel), 'hola')
        expect((await s.fs.read({ path: s.inside(rel) })).data).toBe('hola')
      }
    })
  })
}
