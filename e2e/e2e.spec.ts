import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from '@playwright/test'
import { bufferText, ECHO_SCRIPT, expect, type Stack, test } from './stack.ts'

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

  test('el daemon se cae: la interfaz muestra «Reconectando»; con el daemon nuevo hace falta abrirla con su token', async ({
    stack,
    app,
  }) => {
    const created = await stack.newTab('antes', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expectTerminal(app, created.paneId, 'LISTO')
    const oldToken = stack.token

    await stack.killDaemon()
    const banner = app.getByRole('status').filter({ hasText: 'Reconectando' })
    await expect(banner.first()).toBeVisible()

    // Hoy: cada arranque del daemon genera un token nuevo, así que la página abierta (con el token viejo)
    // sigue reintentando sin poder volver; no se recupera sola. Se recupera abriéndola con el token nuevo.
    await stack.startDaemon()
    expect(stack.token).not.toBe(oldToken)
    await sleep(3000)
    await expect(
      app
        .getByRole('status')
        .filter({ hasText: /Reconectando|Sin conexión/ })
        .first(),
    ).toBeVisible()

    await app.goto(stack.url())
    await expect(app.getByRole('status').filter({ hasText: 'Reconectando' })).toHaveCount(0)
    // El daemon de la F1 no persiste el estado: el nuevo arranca vacío y vuelve a ser operable.
    await expect(app.getByRole('tab')).toHaveCount(0)
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
})
