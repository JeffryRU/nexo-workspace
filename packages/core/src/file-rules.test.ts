import { describe, expect, it } from 'vitest'
import {
  checkPathSyntax,
  detectFileType,
  isSensitivePath,
  isValidUtf8,
  isWindowsDeviceName,
  isWithin,
  looksLikeSvg,
  mimeOf,
  pathSegments,
  SNIFF_BYTES,
  startsOnBoundary,
  utf8SafeLength,
} from './file-rules.ts'
import { utf8Bytes } from './test-helpers.ts'

const bytes = utf8Bytes

describe('checkPathSyntax', () => {
  it('acepta rutas absolutas normales', () => {
    expect(checkPathSyntax('/home/a/proyecto/README.md', 'posix')).toBeUndefined()
    expect(checkPathSyntax('/a b/ñ/日本.txt', 'posix')).toBeUndefined()
    expect(checkPathSyntax('C:\\Users\\a\\proyecto\\README.md', 'win32')).toBeUndefined()
    expect(checkPathSyntax('c:/Users/a/x.txt', 'win32')).toBeUndefined()
    expect(checkPathSyntax('C:\\a\\.\\b.txt', 'win32')).toBeUndefined()
  })

  it('rechaza lo vacío, lo relativo, los controles y lo larguísimo', () => {
    for (const p of [
      '',
      'a/b',
      './a',
      '../a',
      'a\0b',
      '/a\nb',
      '/a\x7fb',
      `/${'x'.repeat(4100)}`,
    ]) {
      expect(checkPathSyntax(p, 'posix'), JSON.stringify(p.slice(0, 12))).toBeDefined()
    }
  })

  it('rechaza `..` como segmento pero no como parte de un nombre', () => {
    expect(checkPathSyntax('/a/../b', 'posix')).toContain('..')
    expect(checkPathSyntax('/a/..', 'posix')).toContain('..')
    expect(checkPathSyntax('/a/..b/c..', 'posix')).toBeUndefined()
    expect(checkPathSyntax('C:\\a\\..\\b', 'win32')).toContain('..')
    expect(checkPathSyntax('C:\\a/../b', 'win32')).toContain('..')
  })

  it('Windows: UNC, espacios de nombres de dispositivos y rutas sin unidad', () => {
    expect(checkPathSyntax('\\\\srv\\share\\a', 'win32')).toBe('ruta UNC')
    expect(checkPathSyntax('//srv/share/a', 'win32')).toBe('ruta UNC')
    expect(checkPathSyntax('\\\\?\\C:\\a', 'win32')).toContain('dispositivos')
    expect(checkPathSyntax('\\\\.\\COM1', 'win32')).toContain('dispositivos')
    expect(checkPathSyntax('//?/C:/a', 'win32')).toContain('dispositivos')
    expect(checkPathSyntax('\\??\\C:\\a', 'win32')).toContain('NT')
    for (const p of ['C:a', 'C:', '\\a', 'a\\b', 'C']) {
      expect(checkPathSyntax(p, 'win32'), p).toContain('absoluta')
    }
  })

  it('Windows: dispositivos, flujos, comodines y puntos finales', () => {
    for (const name of [
      'CON',
      'con',
      'NUL.txt',
      'com1',
      'LPT3.tar.gz',
      'aux .md',
      'COM\u00b9',
      'CONIN$',
    ]) {
      expect(checkPathSyntax(`C:\\a\\${name}`, 'win32'), name).toBeDefined()
      expect(checkPathSyntax(`C:\\a\\${name}\\x`, 'win32'), name).toBeDefined()
    }
    for (const name of [
      'a.txt:s',
      'a.txt::$DATA',
      'a<b',
      'a>b',
      'a"b',
      'a|b',
      'a?b',
      'a*b',
      'a.',
      'a ',
      '...',
    ]) {
      expect(checkPathSyntax(`C:\\a\\${name}`, 'win32'), name).toBeDefined()
    }
    for (const name of ['CONSOLE', 'com10', 'nulo.txt', 'a.b', '.hidden', 'LPT', 'COM']) {
      expect(checkPathSyntax(`C:\\a\\${name}`, 'win32'), name).toBeUndefined()
    }
  })

  it('con reglas POSIX, una ruta de Windows no es absoluta', () => {
    expect(checkPathSyntax('C:\\a\\b', 'posix')).toContain('absoluta')
    expect(checkPathSyntax('\\\\srv\\x', 'posix')).toContain('absoluta')
  })
})

describe('isWindowsDeviceName', () => {
  it('ignora mayúsculas, extensión y espacios finales', () => {
    expect(isWindowsDeviceName('Nul')).toBe(true)
    expect(isWindowsDeviceName('prn.log')).toBe(true)
    expect(isWindowsDeviceName('com0')).toBe(true)
    expect(isWindowsDeviceName('lpt\u00b2.x')).toBe(true)
    expect(isWindowsDeviceName('nada')).toBe(false)
    expect(isWindowsDeviceName('.con')).toBe(false)
  })
})

describe('pathSegments', () => {
  it('quita la unidad y las barras repetidas', () => {
    expect(pathSegments('C:\\a\\\\b/c', 'win32')).toEqual(['a', 'b', 'c'])
    expect(pathSegments('/a//b/', 'posix')).toEqual(['a', 'b'])
    expect(pathSegments('/', 'posix')).toEqual([])
    expect(pathSegments('C:\\', 'win32')).toEqual([])
  })
})

describe('isSensitivePath', () => {
  const sensitive = (p: string) => isSensitivePath(pathSegments(p, 'posix'))

  it('bloquea carpetas sensibles en cualquier posición, sin distinguir mayúsculas', () => {
    for (const d of [
      '.ssh',
      '.gnupg',
      '.aws',
      '.azure',
      '.kube',
      '.docker',
      '.codex',
      '.claude',
      '.gemini',
      '.git',
    ]) {
      expect(sensitive(`/home/u/${d}/x`), d).toBe(true)
      expect(sensitive(`/home/u/p/${d.toUpperCase()}`), d).toBe(true)
    }
    expect(sensitive('/home/u/.config/gcloud/a.json')).toBe(true)
    expect(sensitive('/home/u/.Config/GCloud')).toBe(true)
    expect(sensitive('/home/u/.config/gh/hosts.yml')).toBe(true)
    expect(sensitive('/home/u/AppData/Roaming/gcloud/x')).toBe(true)
    expect(sensitive('/home/u/AppData/Roaming/Microsoft/Credentials/x')).toBe(true)
    expect(sensitive('/home/u/.local/share/keyrings/x')).toBe(true)
  })

  it('un segmento con punto o espacio final (Windows) no esquiva el bloqueo', () => {
    expect(sensitive('/home/u/.ssh./x')).toBe(true)
    expect(sensitive('/home/u/.ssh /x')).toBe(true)
  })

  it('bloquea archivos de credenciales y variables de entorno', () => {
    for (const f of [
      '.netrc',
      '_netrc',
      '.npmrc',
      '.pypirc',
      '.git-credentials',
      '.pgpass',
      'id_rsa',
      'id_ed25519',
      'a.pfx',
      'b.P12',
      'c.kdbx',
      '.env',
      '.env.local',
      '.ENV.production',
      '.credentials.json',
    ]) {
      expect(sensitive(`/p/${f}`), f).toBe(true)
    }
  })

  it('deja pasar lo parecido pero inofensivo', () => {
    for (const f of [
      '.env.example',
      '.env.sample',
      '.env.template',
      '.gitignore',
      '.github/a.yml',
      'id_rsa.pub',
      'ssh/a',
      'config/gcloud',
      'environment.ts',
      '.envrc',
      'README.md',
      '.config/otra',
    ]) {
      expect(sensitive(`/p/${f}`), f).toBe(false)
    }
    expect(isSensitivePath([])).toBe(false)
  })
})

describe('isWithin', () => {
  it('compara segmentos, no prefijos de texto', () => {
    expect(isWithin(['a', 'b'], ['a', 'b'], false)).toBe(true)
    expect(isWithin(['a', 'b'], ['a', 'b', 'c'], false)).toBe(true)
    expect(isWithin(['a', 'b'], ['a', 'bc'], false)).toBe(false)
    expect(isWithin(['a', 'b'], ['a'], false)).toBe(false)
    expect(isWithin(['a', 'B'], ['a', 'b'], false)).toBe(false)
    expect(isWithin(['a', 'B'], ['A', 'b', 'x'], true)).toBe(true)
  })
})

describe('detectFileType', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

  it('firmas', () => {
    expect(detectFileType(png, 'a.bin', true).type).toBe('png')
    expect(detectFileType(Uint8Array.from([0xff, 0xd8, 0xff, 0]), 'a', true).type).toBe('jpeg')
    expect(detectFileType(bytes('GIF87a....'), 'a', true).type).toBe('gif')
    expect(detectFileType(bytes('GIF89a....'), 'a', true).type).toBe('gif')
    expect(detectFileType(bytes('RIFF\0\0\0\0WEBPVP8 '), 'a', true).type).toBe('webp')
    expect(detectFileType(bytes('RIFF\0\0\0\0WAVEfmt '), 'a.wav', true).type).toBe('binary')
    expect(detectFileType(bytes('%PDF-1.4\n'), 'a', true).type).toBe('pdf')
    expect(detectFileType(bytes('  %PDF-1.4'), 'a.txt', true).type).toBe('text')
    expect(mimeOf('png')).toBe('image/png')
  })

  it('texto, Markdown y binario por contenido', () => {
    expect(detectFileType(bytes('hola'), 'a.txt', true).type).toBe('text')
    expect(detectFileType(bytes('# t'), 'LEEME.MD', true)).toEqual({
      type: 'markdown',
      mime: 'text/markdown',
    })
    expect(detectFileType(bytes('# t'), 'a.mdx', true).type).toBe('markdown')
    expect(detectFileType(bytes(''), 'a.md', true).type).toBe('markdown')
    expect(detectFileType(Uint8Array.from([0, 1, 2]), 'a.md', true).type).toBe('binary')
    expect(detectFileType(Uint8Array.from([0x41, 0x01]), 'a.txt', true).type).toBe('binary')
    expect(detectFileType(Uint8Array.from([0xff, 0xfe, 0x41, 0]), 'a.txt', true).type).toBe(
      'binary',
    )
    expect(detectFileType(bytes('\t\n\r\f\x1b[0m ok'), 'a.log', true).type).toBe('text')
  })

  it('un trozo cortado en medio de un carácter solo es válido si no es el archivo entero', () => {
    const data = new Uint8Array(SNIFF_BYTES).fill(0x61)
    data[SNIFF_BYTES - 1] = 0xe2
    expect(detectFileType(data, 'a.txt', false).type).toBe('text')
    expect(detectFileType(data, 'a.txt', true).type).toBe('binary')
  })

  it('svg: solo con extensión y raíz <svg>', () => {
    const svg = '<svg xmlns="x"></svg>'
    expect(detectFileType(bytes(svg), 'a.svg', true).type).toBe('svg')
    expect(detectFileType(bytes(svg), 'a.txt', true).type).toBe('text')
    expect(detectFileType(bytes('hola'), 'a.svg', true).type).toBe('text')
    expect(detectFileType(bytes('<html><svg></svg></html>'), 'a.svg', true).type).toBe('text')
  })
})

describe('looksLikeSvg', () => {
  it('salta prólogo, comentarios y DOCTYPE', () => {
    expect(
      looksLikeSvg(
        '\ufeff  <?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "a" "b">\n<svg width="1"/>',
      ),
    ).toBe(true)
    expect(looksLikeSvg('<!DOCTYPE svg [ <!ENTITY a "b"> ]>\n<SVG>')).toBe(true)
    expect(looksLikeSvg('<svg/>')).toBe(true)
    expect(looksLikeSvg('<svg>')).toBe(true)
  })

  it('rechaza lo que no es un documento SVG o está mal cerrado', () => {
    for (const t of [
      '',
      'texto',
      '<svgx>',
      '<?xml',
      '<!-- sin cierre <svg>',
      '<!DOCTYPE svg [ sin cierre',
      '<!DOCTYPE sin cierre',
      '<div><svg>',
      '<!-- a --><p>',
    ]) {
      expect(looksLikeSvg(t), t).toBe(false)
    }
  })

  it('no se atasca con muchos comentarios o prólogos', () => {
    expect(looksLikeSvg('<!---->'.repeat(500))).toBe(false)
    expect(looksLikeSvg(`${'<?a?>'.repeat(100)}<svg/>`)).toBe(false)
  })
})

describe('UTF-8', () => {
  it('isValidUtf8 estricto', () => {
    expect(isValidUtf8(bytes('añ€🎉'))).toBe(true)
    for (const bad of [
      [0xc0, 0x80],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xf0, 0x80, 0x80, 0x80],
      [0xff],
      [0x80],
      [0xc3, 0x28],
      [0xe2, 0x82],
    ]) {
      expect(isValidUtf8(Uint8Array.from(bad)), bad.join(',')).toBe(false)
    }
    expect(isValidUtf8(Uint8Array.from([0xe2, 0x82]), true)).toBe(true)
    expect(isValidUtf8(Uint8Array.from([0xe2, 0x41]), true)).toBe(false)
    expect(isValidUtf8(Uint8Array.from([0x61, 0xf0, 0x9f]), true)).toBe(true)
  })

  it('utf8SafeLength recorta un carácter incompleto al final salvo en el final del archivo', () => {
    const euro = bytes('a€') // 61 e2 82 ac
    expect(utf8SafeLength(euro, false)).toBe(4)
    expect(utf8SafeLength(euro.subarray(0, 3), false)).toBe(1)
    expect(utf8SafeLength(euro.subarray(0, 2), false)).toBe(1)
    expect(utf8SafeLength(euro.subarray(0, 3), true)).toBe(3)
    expect(utf8SafeLength(new Uint8Array(0), false)).toBe(0)
    expect(utf8SafeLength(Uint8Array.from([0x80, 0x80, 0x80, 0x80]), false)).toBe(4)
    expect(startsOnBoundary(0x61)).toBe(true)
    expect(startsOnBoundary(0xe2)).toBe(true)
    expect(startsOnBoundary(0x82)).toBe(false)
  })
})
