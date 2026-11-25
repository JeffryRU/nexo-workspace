import { describe, expect, it, vi } from 'vitest'
import {
  type BrowserWindowLike,
  browserSource,
  detectSource,
  tauriSource,
  validateInfo,
} from './info.ts'

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345-_'

function fakeWindow(search: string, extra: object = {}) {
  const replaceState = vi.fn()
  const win = {
    location: { search, pathname: '/app/', hash: '#x' },
    history: { replaceState },
    ...extra,
  } as BrowserWindowLike & { __TAURI__?: unknown }
  return { win, replaceState }
}

describe('browserSource', () => {
  it('lee puerto y token y borra el token de la barra de direcciones', async () => {
    const { win, replaceState } = fakeWindow(`?port=4400&t=${TOKEN}&otro=1`)
    const r = await browserSource(win).getDaemonInfo()
    expect(r).toEqual({ ok: true, info: { port: 4400, token: TOKEN } })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/?port=4400&otro=1#x')
    expect(JSON.stringify(replaceState.mock.calls)).not.toContain(TOKEN)
  })

  it('sin otros parámetros deja la ruta limpia y usa el puerto por omisión', async () => {
    const { win, replaceState } = fakeWindow(`?t=${TOKEN}`)
    const r = await browserSource(win).getDaemonInfo()
    expect(r).toEqual({ ok: true, info: { port: 4317, token: TOKEN } })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/#x')
  })

  it('conserva los datos en memoria para los reintentos (la URL ya no tiene el token)', async () => {
    const { win } = fakeWindow(`?port=4400&t=${TOKEN}`)
    const source = browserSource(win)
    await source.getDaemonInfo()
    win.location.search = '?port=4400'
    expect(await source.getDaemonInfo()).toMatchObject({ ok: true })
  })

  it('no guarda nada en localStorage ni sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { win } = fakeWindow(`?t=${TOKEN}`)
    await browserSource(win).getDaemonInfo()
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('sin token informa el motivo y no toca la URL', async () => {
    const { win, replaceState } = fakeWindow('?port=4400')
    expect(await browserSource(win).getDaemonInfo()).toEqual({ ok: false, reason: 'missing-token' })
    expect(replaceState).not.toHaveBeenCalled()
  })
})

describe('validateInfo (adversarial)', () => {
  it.each([
    ['0', TOKEN, 'invalid-port'],
    ['70000', TOKEN, 'invalid-port'],
    ['-1', TOKEN, 'invalid-port'],
    ['44.5', TOKEN, 'invalid-port'],
    ['4400abc', TOKEN, 'invalid-port'],
    ['4400', 'corto', 'invalid-token'],
    ['4400', 'tiene espacios y símbolos <script>', 'invalid-token'],
    ['4400', 'a'.repeat(513), 'invalid-token'],
    ['4400', '', 'missing-token'],
    ['4400', null, 'missing-token'],
    ['4400', 123, 'invalid-token'],
    [Number.NaN, TOKEN, 'invalid-port'],
  ])('puerto %s y token %s -> %s', (port, token, reason) => {
    expect(validateInfo(port, token)).toEqual({ ok: false, reason })
  })

  it('el token inválido también se borra de la barra', async () => {
    const { win, replaceState } = fakeWindow('?port=4400&t=%3Cscript%3E')
    expect(await browserSource(win).getDaemonInfo()).toEqual({ ok: false, reason: 'invalid-token' })
    expect(replaceState).toHaveBeenCalledOnce()
  })
})

describe('Tauri', () => {
  it('detecta window.__TAURI__ y usa el comando daemon_info', async () => {
    const invoke = vi.fn(async () => ({ port: 4500, token: TOKEN }))
    const { win } = fakeWindow('', { __TAURI__: { core: { invoke } } })
    const r = await detectSource(win).getDaemonInfo()
    expect(invoke).toHaveBeenCalledWith('daemon_info')
    expect(r).toEqual({ ok: true, info: { port: 4500, token: TOKEN } })
  })

  it('acepta la forma antigua __TAURI__.invoke', async () => {
    const invoke = vi.fn(async () => ({ port: 4500, token: TOKEN }))
    const { win } = fakeWindow('', { __TAURI__: { invoke } })
    expect(await detectSource(win).getDaemonInfo()).toMatchObject({ ok: true })
  })

  it('sin Tauri usa el navegador', async () => {
    const { win } = fakeWindow(`?t=${TOKEN}`, { __TAURI__: {} })
    expect(await detectSource(win).getDaemonInfo()).toMatchObject({ ok: true })
  })

  it('respuestas hostiles o errores del comando', async () => {
    expect(await tauriSource(async () => null).getDaemonInfo()).toEqual({
      ok: false,
      reason: 'tauri-error',
    })
    expect(await tauriSource(async () => 'x').getDaemonInfo()).toEqual({
      ok: false,
      reason: 'tauri-error',
    })
    expect(await tauriSource(async () => ({ port: 1, token: 'x' })).getDaemonInfo()).toEqual({
      ok: false,
      reason: 'invalid-token',
    })
    expect(
      await tauriSource(async () => {
        throw new Error('no existe el comando')
      }).getDaemonInfo(),
    ).toEqual({ ok: false, reason: 'tauri-error' })
  })
})
