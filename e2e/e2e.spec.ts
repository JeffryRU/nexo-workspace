import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from '@playwright/test'
import { bufferText, ECHO_SCRIPT, expect, type Stack, test, WEB_ORIGIN } from './stack.ts'

/** Espera a que el xterm del panel contenga el texto (lee el búfer de xterm, no capturas). */
async function expectTerminal(page: Page, paneId: string, text: string): Promise<void> {
  await expect
    .poll(async () => (await bufferText(page, paneId)) ?? '', { timeout: 20_000 })
    .toContain(text)
}

async function readPane(stack: Stack, paneId: string): Promise<string> {
  return (await stack.nexo(['read', paneId, '--lines', '200'])).stdout
}

test.describe('CLI y ventana sobre el mismo daemon', () => {
  test('la CLI crea una pestaña, escribe y lee, y la interfaz lo muestra en el xterm del panel', async ({
    stack,
    app,
  }) => {
    await app.goto(stack.url())
    const created = await stack.newTab('eco', ECHO_SCRIPT)
    await expect(app.getByRole('tab', { name: 'eco' })).toBeVisible()
    await expectTerminal(app, created.paneId, 'LISTO')

    const sent = await stack.nexo(['send', created.paneId, '--enter', 'hola', 'mundo'])
    expect(sent.code).toBe(0)
    await expectTerminal(app, created.paneId, 'eco:"hola mundo')
    await expect.poll(() => readPane(stack, created.paneId)).toContain('eco:"hola mundo')
  })

  test('escribir en la interfaz: `nexo read` lo ve', async ({ stack, app }) => {
    const created = await stack.newTab('eco', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expectTerminal(app, created.paneId, 'LISTO')

    await app.locator(`[data-pane-id="${created.paneId}"] .xterm`).click()
    await app.keyboard.insertText('desde-la-interfaz-42')
    await app.keyboard.press('Enter')
    await expect.poll(() => readPane(stack, created.paneId)).toContain('desde-la-interfaz-42')
    await expectTerminal(app, created.paneId, 'desde-la-interfaz-42')
  })

  test('split, rename y close de la CLI se reflejan en vivo', async ({ stack, app }) => {
    const first = await stack.newTab('uno', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'uno' })).toBeVisible()
    await expect(app.locator('section.pane')).toHaveCount(1)

    const split = await stack.json<{ paneId: string }>([
      'split',
      first.paneId,
      '--right',
      '--',
      process.execPath,
      '-e',
      ECHO_SCRIPT,
    ])
    await expect(app.locator('section.pane')).toHaveCount(2)
    await expectTerminal(app, split.paneId, 'LISTO')

    expect((await stack.nexo(['rename', 'uno', 'renombrada'])).code).toBe(0)
    await expect(app.getByRole('tab', { name: 'renombrada' })).toBeVisible()
    await expect(app.getByRole('tab', { name: 'uno' })).toHaveCount(0)

    expect((await stack.nexo(['close', split.paneId])).code).toBe(0)
    await expect(app.locator('section.pane')).toHaveCount(1)

    expect((await stack.nexo(['close', 'renombrada'])).code).toBe(0)
    await expect(app.getByRole('tab')).toHaveCount(0)
  })

  test('escritorio (daemon_info simulado): al reiniciar el daemon con token nuevo la página se recupera sola', async ({
    stack,
    app,
  }) => {
    // Simula el shell de Tauri: `invoke('daemon_info')` lee el estado actual del daemon (puerto y token) y
    // falla mientras no hay daemon, como `ensure_daemon` cuando no logra arrancarlo.
    await app.exposeFunction('__nexoDaemonInfo', () => {
      if (!stack.running) throw new Error('el daemon no está en marcha')
      return { port: stack.port, token: stack.token }
    })
    await app.addInitScript(() => {
      const w = globalThis as unknown as { __TAURI__: unknown; __nexoDaemonInfo: () => unknown }
      w.__TAURI__ = { core: { invoke: () => w.__nexoDaemonInfo() } }
    })
    const created = await stack.newTab('antes', ECHO_SCRIPT)
    await app.goto(WEB_ORIGIN)
    await expectTerminal(app, created.paneId, 'LISTO')
    const oldToken = stack.token

    await stack.killDaemon()
    await expect(app.getByRole('status').filter({ hasText: 'Reconectando' }).first()).toBeVisible()
    await sleep(1500) // varios reintentos con `daemon_info` fallando: sin bucle apretado, sigue reintentando

    await stack.startDaemon()
    expect(stack.token).not.toBe(oldToken)
    // Sin recargar ni abrir otra dirección: la página redescubre el token y vuelve sola.
    await expect(
      app.getByRole('status').filter({ hasText: /Reconectando|Sin conexión/ }),
    ).toHaveCount(0, { timeout: 45_000 })
    await expect(app.getByRole('tab')).toHaveCount(0)
    const again = await stack.newTab('despues', ECHO_SCRIPT)
    await expect(app.getByRole('tab', { name: 'despues' })).toBeVisible()
    await expectTerminal(app, again.paneId, 'LISTO')
  })

  test('navegador: tras reiniciar el daemon avisa de que hay que abrir la nueva dirección, y esa dirección funciona', async ({
    stack,
    app,
  }) => {
    const created = await stack.newTab('antes', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expectTerminal(app, created.paneId, 'LISTO')
    // F5: el token ya no está en la dirección, pero la pestaña lo conserva en sessionStorage.
    await app.reload()
    await expect(app.getByRole('tab', { name: 'antes' })).toBeVisible()
    expect(await app.evaluate(() => globalThis.localStorage.length)).toBe(0)
    expect(new URL(app.url()).searchParams.has('t')).toBe(false)
    const oldToken = stack.token

    await stack.killDaemon()
    await expect(app.getByRole('status').filter({ hasText: 'Reconectando' }).first()).toBeVisible()
    await stack.startDaemon()
    expect(stack.token).not.toBe(oldToken)
    // No hay forma segura de obtener el token nuevo: mensaje claro en vez de «Reconectando» eterno.
    await expect(app.getByText(/El daemon se reinició/).first()).toBeVisible({ timeout: 45_000 })

    await app.goto(stack.url())
    await expect(
      app.getByRole('status').filter({ hasText: /Reconectando|Sin conexión/ }),
    ).toHaveCount(0)
    const again = await stack.newTab('despues', ECHO_SCRIPT)
    await expect(app.getByRole('tab', { name: 'despues' })).toBeVisible()
    await expectTerminal(app, again.paneId, 'LISTO')
  })

  test('recargar la página conserva el estado y el scrollback de las terminales', async ({
    stack,
    app,
  }) => {
    const script =
      "for(let i=0;i<300;i++)console.log('fila-'+i);console.log('FIN-FILAS');setInterval(()=>{},1000)"
    const created = await stack.newTab('historial', script)
    await app.goto(stack.url())
    await expectTerminal(app, created.paneId, 'FIN-FILAS')
    expect(await bufferText(app, created.paneId)).toContain('fila-0')

    // El token se quita de la barra de direcciones al cargar (nunca se guarda): se recarga con la dirección
    // completa, como lo hace `pnpm dev:web` o la ventana de escritorio.
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'historial' })).toBeVisible()
    await expectTerminal(app, created.paneId, 'FIN-FILAS')
    const text = (await bufferText(app, created.paneId)) ?? ''
    expect(text).toContain('fila-0')
    expect(text).toContain('fila-299')
    await sleep(50)
  })

  test('arrastrar el divisor central de una cuadrícula 2x2 redimensiona los dos subárboles', async ({
    stack,
    app,
  }) => {
    const a = await stack.newTab('rejilla', ECHO_SCRIPT)
    await app.goto(stack.url())
    const splitArgs = ['--', process.execPath, '-e', ECHO_SCRIPT]
    const b = await stack.json<{ paneId: string }>(['split', a.paneId, '--right', ...splitArgs])
    await stack.json(['split', a.paneId, '--down', ...splitArgs])
    await stack.json(['split', b.paneId, '--down', ...splitArgs])
    await expect(app.locator('section.pane')).toHaveCount(4)

    const width = async (id: string) =>
      (await app.locator(`[data-pane-id="${id}"]`).boundingBox())?.width ?? 0
    const before = await width(a.paneId)
    const central = app.locator('hr.divider.vertical').first()
    const box = await central.boundingBox()
    if (box === null) throw new Error('sin divisor central')
    const y = box.y + box.height / 2
    await app.mouse.move(box.x + box.width / 2, y)
    await app.mouse.down()
    await app.mouse.move(box.x + box.width / 2 + 150, y, { steps: 10 })
    await app.mouse.up()

    await expect.poll(() => width(a.paneId)).toBeGreaterThan(before + 100)
    // Ambos subárboles se movieron juntos: el panel de la derecha se achicó lo mismo.
    const wa = await width(a.paneId)
    const wb = await width(b.paneId)
    expect(wa).toBeGreaterThan(wb)
    expect(Math.abs(wa + wb - 2 * before)).toBeLessThan(8)
  })
})
