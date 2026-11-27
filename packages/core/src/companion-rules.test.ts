import {
  decodeUtf8,
  encodeBase64,
  encodeUtf8,
  TINY_SVG,
  tinyCompanion,
  tinyGif,
  tinyPng,
  tinyWebp,
} from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import {
  base64Encode,
  checkSheetFits,
  checkSvgSafety,
  companionTarget,
  inspectCompanionImage,
  manifestAssetPaths,
  parseCompanionManifest,
  parseCompanionManifestText,
} from './companion-rules.ts'

const text = (s: string) => encodeUtf8(s)
const manifestOf = (patch: Record<string, unknown> = {}) =>
  JSON.parse(decodeUtf8(tinyCompanion({ manifest: patch })['companion.json'] as Uint8Array))

describe('parseCompanionManifest', () => {
  it('acepta el paquete de prueba y lista sus recursos sin repetir', () => {
    const r = parseCompanionManifest(manifestOf(), 'tiny')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(manifestAssetPaths(r.value)).toEqual([
      'idle.png',
      'img/think.gif',
      'sheet.png',
      'done.webp',
      'error.svg',
    ])
    const same = parseCompanionManifest(
      manifestOf({ states: { idle: { src: 'a.png' }, done: { src: 'a.png' } } }),
    )
    expect(same.ok && manifestAssetPaths(same.value)).toEqual(['a.png'])
  })

  it('rechaza claves de más, falta de idle, versiones y licencias raras', () => {
    const bad = [
      { extra: 1 },
      { states: { thinking: { src: 'a.png' } } },
      { version: 'uno' },
      { license: '<script>' },
      { format: 2 },
      { author: { name: 'x', url: 'http://inseguro.example' } },
      { author: { name: 'x', url: 'javascript:alert(1)' } },
      { name: 'con\u001bcontrol' },
      { id: 'Mayus' },
      {
        states: {
          idle: { src: 'a.png', sheet: { frameWidth: 0, frameHeight: 1, frames: 1, fps: 1 } },
        },
      },
      {
        states: {
          idle: {
            src: 'a.png',
            sheet: { frameWidth: 1, frameHeight: 1, frames: 2, columns: 3, fps: 1 },
          },
        },
      },
      {
        states: {
          idle: { src: 'a.png', sheet: { frameWidth: 1, frameHeight: 1, frames: 1, fps: 1000 } },
        },
      },
    ]
    for (const patch of bad)
      expect(parseCompanionManifest(manifestOf(patch)).ok, JSON.stringify(patch)).toBe(false)
  })

  it('exige que el id sea el de la carpeta y no sea un nombre reservado de Windows', () => {
    expect(parseCompanionManifest(manifestOf(), 'otro').ok).toBe(false)
    expect(parseCompanionManifest(manifestOf({ id: 'con' }), 'con').ok).toBe(false)
    expect(parseCompanionManifest(manifestOf({ id: 'com1' })).ok).toBe(false)
  })

  it('rechaza rutas con nombres de dispositivo de Windows', () => {
    for (const src of ['nul.png', 'img/CON.png', 'aux.png', 'com1.webp', 'lpt9.gif']) {
      expect(parseCompanionManifest(manifestOf({ states: { idle: { src } } })).ok, src).toBe(false)
    }
  })

  it('el texto del manifiesto: JSON, BOM y tope de bytes', () => {
    const ok = JSON.stringify(manifestOf())
    expect(parseCompanionManifestText(ok, 'tiny').ok).toBe(true)
    expect(parseCompanionManifestText(`﻿${ok}`, 'tiny').ok).toBe(true)
    expect(parseCompanionManifestText('{no', 'tiny')).toMatchObject({ ok: false })
    expect(parseCompanionManifestText(`{"a":"${'x'.repeat(70_000)}"}`)).toMatchObject({
      ok: false,
      reason: 'manifiesto demasiado grande',
    })
  })

  it('el motivo no repite el contenido hostil', () => {
    const r = parseCompanionManifest({ ...manifestOf(), [`x${'y'.repeat(10)}`]: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.length).toBeLessThan(200)
  })
})

describe('inspectCompanionImage', () => {
  it('reconoce PNG, GIF, WebP y SVG y sus dimensiones', () => {
    expect(inspectCompanionImage(tinyPng(3, 2), 'a.png')).toEqual({
      ok: true,
      value: { mime: 'image/png', width: 3, height: 2 },
    })
    expect(inspectCompanionImage(tinyGif(), 'a.gif')).toEqual({
      ok: true,
      value: { mime: 'image/gif', width: 1, height: 1 },
    })
    expect(inspectCompanionImage(tinyWebp(), 'a.webp')).toEqual({
      ok: true,
      value: { mime: 'image/webp', width: 1, height: 1 },
    })
    expect(inspectCompanionImage(text(TINY_SVG), 'a.svg')).toEqual({
      ok: true,
      value: { mime: 'image/svg+xml' },
    })
  })

  it('la extensión mayúscula vale; la que no coincide con el tipo, no', () => {
    expect(inspectCompanionImage(tinyPng(), 'A.PNG').ok).toBe(true)
    expect(inspectCompanionImage(tinyPng(), 'a.gif').ok).toBe(false)
    expect(inspectCompanionImage(tinyGif(), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(text(TINY_SVG), 'a.png').ok).toBe(false)
  })

  it('rechaza lo que no es imagen: vacío, texto, HTML, JPEG, PDF, PNG truncado', () => {
    expect(inspectCompanionImage(new Uint8Array(), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(text('hola'), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(text('<html></html>'), 'a.svg').ok).toBe(false)
    expect(inspectCompanionImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(text('%PDF-1.7'), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(tinyPng().slice(0, 12), 'a.png').ok).toBe(false)
    expect(inspectCompanionImage(tinyPng(), 'a.jpg').ok).toBe(false)
  })

  it('rechaza dimensiones absurdas del encabezado (bombas de descompresión)', () => {
    expect(inspectCompanionImage(tinyPng(5000, 1), 'a.png')).toMatchObject({ ok: false })
    const png = tinyPng()
    png.set([0, 0, 0, 0], 16)
    expect(inspectCompanionImage(png, 'a.png')).toMatchObject({ ok: false })
    const gif = tinyGif()
    gif.set([0, 0], 6)
    expect(inspectCompanionImage(gif, 'a.gif')).toMatchObject({ ok: false })
  })

  it('rechaza lo que pasa del tope de recurso', () => {
    const big = new Uint8Array(512 * 1024 + 1)
    big.set(tinyPng())
    expect(inspectCompanionImage(big, 'a.png')).toMatchObject({ ok: false })
  })

  it('WebP: variantes VP8X y VP8, y los que no se reconocen', () => {
    const x = new Uint8Array(32)
    x.set([...encodeUtf8('RIFF')], 0)
    x.set([...encodeUtf8('WEBP')], 8)
    x.set([...encodeUtf8('VP8X')], 12)
    x.set([9, 0, 0], 24)
    x.set([4, 0, 0], 27)
    expect(inspectCompanionImage(x, 'a.webp')).toMatchObject({ value: { width: 10, height: 5 } })
    const lossy = new Uint8Array(32)
    lossy.set([...encodeUtf8('RIFF')], 0)
    lossy.set([...encodeUtf8('WEBP')], 8)
    lossy.set([...encodeUtf8('VP8 ')], 12)
    lossy.set([0x9d, 0x01, 0x2a, 7, 0, 3, 0], 23)
    expect(inspectCompanionImage(lossy, 'a.webp')).toMatchObject({ value: { width: 7, height: 3 } })
    lossy.set([...encodeUtf8('ZZZZ')], 12)
    expect(inspectCompanionImage(lossy, 'a.webp').ok).toBe(false)
  })
})

describe('checkSvgSafety', () => {
  const svg = (inner: string, attrs = '') =>
    text(`<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${inner}</svg>`)

  it('acepta un SVG simple, con estilos y referencias locales', () => {
    expect(checkSvgSafety(text(TINY_SVG))).toBeUndefined()
    expect(checkSvgSafety(text(`<?xml version="1.0"?>\n${TINY_SVG}`))).toBeUndefined()
    expect(
      checkSvgSafety(
        svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)" style="fill:url(#g)"/>'),
      ),
    ).toBeUndefined()
    expect(checkSvgSafety(svg('<use href="#a"/><use xlink:href="#a"/>'))).toBeUndefined()
    expect(checkSvgSafety(svg('<image href="data:image/png;base64,AAAA"/>'))).toBeUndefined()
    expect(checkSvgSafety(Uint8Array.from([0xef, 0xbb, 0xbf, ...text(TINY_SVG)]))).toBeUndefined()
    expect(checkSvgSafety(svg('<text>Año &amp; ñandú</text>'))).toBeUndefined()
  })

  it('rechaza scripts, manejadores, javascript:, foreignObject, marcos y objetos', () => {
    const bad = [
      svg('<script>alert(1)</script>'),
      svg('<SCRIPT>alert(1)</SCRIPT>'),
      svg('<rect/>', ' onload="alert(1)"'),
      svg('<rect onclick = "x()"/>'),
      svg('<rect/>', "\tonmouseover='x'"),
      svg('<a href="javascript:alert(1)"><rect/></a>'),
      svg('<a href=" JavaScript:alert(1)"><rect/></a>'),
      svg('<a href=javascript:alert(1)><rect/></a>'),
      svg('<foreignObject><body xmlns="http://www.w3.org/1999/xhtml"/></foreignObject>'),
      svg('<iframe src="x"/>'),
      svg('<object data="x"/>'),
      svg('<embed src="x"/>'),
      svg('<animate attributeName="href" to="javascript:alert(1)"/>'),
      svg('<set attributeName="xlink:href" to="x"/>'),
    ]
    for (const b of bad) expect(checkSvgSafety(b), decodeUtf8(b)).toBeDefined()
  })

  it('rechaza referencias externas, entidades, DOCTYPE con subconjunto y @import', () => {
    const bad = [
      svg('<image href="https://evil.example/x.png"/>'),
      svg('<image href="//evil.example/x.png"/>'),
      svg('<use href="otro.svg#a"/>'),
      svg('<image href="data:image/svg+xml;base64,AAAA"/>'),
      svg('<image href="data:text/html;base64,AAAA"/>'),
      svg('<rect style="fill:url(https://evil.example/x)"/>'),
      svg('<style>@import url(https://evil.example/x.css);</style>'),
      svg('<rect fill="url( javascript:x )"/>'),
      text(
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
      ),
      svg('&#106;avascript:alert(1)'),
      svg('&otra;'),
      text('<?xml-stylesheet href="x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
      svg('<link href="x"/>'),
    ]
    for (const b of bad) expect(checkSvgSafety(b), decodeUtf8(b)).toBeDefined()
  })

  it('rechaza lo que no es un SVG o no es UTF-8', () => {
    expect(checkSvgSafety(new Uint8Array())).toBeDefined()
    expect(checkSvgSafety(text('<html/>'))).toBeDefined()
    expect(checkSvgSafety(text('<!-- sin cerrar <svg/>'))).toBeDefined()
    expect(checkSvgSafety(Uint8Array.from([0xff, 0xfe, 0x3c, 0x00]))).toBeDefined()
    expect(
      checkSvgSafety(Uint8Array.from([...text('<svg xmlns="x">'), 0, ...text('</svg>')])),
    ).toBeDefined()
  })
})

describe('checkSheetFits', () => {
  const sheet = { frameWidth: 8, frameHeight: 8, frames: 6, columns: 3, fps: 4 }
  it('compara columnas y filas con la imagen', () => {
    expect(checkSheetFits(sheet, { mime: 'image/png', width: 24, height: 16 })).toBeUndefined()
    expect(checkSheetFits(sheet, { mime: 'image/png', width: 16, height: 16 })).toBeDefined()
    expect(checkSheetFits(sheet, { mime: 'image/png', width: 24, height: 8 })).toBeDefined()
    expect(
      checkSheetFits({ ...sheet, columns: undefined }, { mime: 'image/png', width: 48, height: 8 }),
    ).toBeUndefined()
  })
  it('sin dimensiones conocidas (SVG) no objeta', () => {
    expect(checkSheetFits(sheet, { mime: 'image/svg+xml' })).toBeUndefined()
  })
})

describe('base64Encode', () => {
  it('coincide con Buffer en todos los restos de longitud', () => {
    for (let n = 0; n < 20; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255)
      expect(base64Encode(b)).toBe(encodeBase64(b))
    }
  })
})

describe('companionTarget', () => {
  it('prioridad: needs-input > error > working > done > idle', () => {
    expect(companionTarget([])).toBe('idle')
    expect(companionTarget(['idle', 'idle'])).toBe('idle')
    expect(companionTarget(['done', 'idle'])).toBe('done')
    expect(companionTarget(['done', 'working'])).toBe('thinking')
    expect(companionTarget(['working', 'working'])).toBe('busy')
    expect(companionTarget(['working', 'working', 'error'])).toBe('error')
    expect(companionTarget(['error', 'needs-input', 'working'])).toBe('waiting')
  })
})
