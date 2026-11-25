import type { Page } from '@playwright/test'
import { bufferText, ECHO_SCRIPT, expect, test } from './stack.ts'

declare global {
  var __pwned: unknown
}

const HOSTILE = '<img src=x onerror="globalThis.__pwned=1"><script>globalThis.__pwned=2</script>'

async function pwned(page: Page): Promise<unknown> {
  return page.evaluate(() => globalThis.__pwned)
}

test.describe('adversarial', () => {
  test('un título hostil puesto por la CLI no se ejecuta ni se interpreta como HTML', async ({
    stack,
    app,
  }) => {
    await app.goto(stack.url())
    const created = await stack.newTab(HOSTILE, ECHO_SCRIPT)
    await expect(app.getByRole('tab').first()).toBeVisible()
    await expect(app.getByRole('tab').first()).toContainText('<img src=x')

    // Renombrar con la CLI: con escapes ANSI/OSC el daemon lo rechaza o la interfaz lo sanea.
    await stack.nexo(['rename', HOSTILE, '<svg onload="globalThis.__pwned=3">'])
    await stack.nexo([
      'rename',
      '<svg onload="globalThis.__pwned=3">',
      'a\u001b[31mroja\u001b]0;x\u0007',
    ])

    expect(await pwned(app)).toBeUndefined()
    await expect(app.locator('.tablist img, .tablist svg, .tablist script')).toHaveCount(0)
    await expect(app.locator('.sidebar img, .sidebar svg, .sidebar script')).toHaveCount(0)
    const tabsText = (await app.getByRole('tablist').textContent()) ?? ''
    expect(tabsText).not.toContain('\u001b')
    await expect(app.locator(`[data-pane-id="${created.paneId}"]`)).toBeVisible()
  })

  test('un título puesto por el programa (OSC 0/2) con HTML y escapes se muestra como texto', async ({
    stack,
    app,
  }) => {
    const script = `process.stdout.write('\\x1b]0;${HOSTILE.replaceAll("'", '')}\\x07\\x1b]2;<b onmouseover=1>x</b>\\x1b\\\\LISTO\\n');setInterval(()=>{},1000)`
    const created = await stack.newTab('osc', script)
    await app.goto(stack.url())
    const header = app.locator(`[data-pane-id="${created.paneId}"] .pane-title`)
    await expect(header).toBeVisible()
    await expect(header).toContainText('<b onmouseover=1>x</b>')
    await expect(app.locator('.pane-header b, .pane-header img, .pane-header script')).toHaveCount(
      0,
    )
    expect(await pwned(app)).toBeUndefined()
    expect(await bufferText(app, created.paneId)).toContain('LISTO')
  })

  test('un token incorrecto muestra el error sin filtrar el token', async ({ stack, app }) => {
    const wrong = 'T0kenIncorrecto_abcdefghijklmnopqrstuvwxyz0123456789'
    const seen: string[] = []
    app.on('console', (m) => seen.push(m.text()))
    app.on('pageerror', (e) => seen.push(String(e)))
    app.on('request', (r) => seen.push(r.url()))

    await app.goto(`http://localhost:5173/?port=${stack.port}&t=${wrong}`)
    await expect(app.getByRole('alert').or(app.getByRole('status')).first()).toBeVisible()
    await expect(app.getByText(/Sin conexión|Reconectando|No se pudo/).first()).toBeVisible({
      timeout: 30_000,
    })

    expect(app.url()).not.toContain(wrong)
    expect(await app.content()).not.toContain(wrong)
    expect(await app.evaluate(() => document.body.textContent)).not.toContain(wrong)
    expect(await app.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(wrong)
    // El navegador solo lo manda al abrir el WebSocket (en el protocolo, no en la URL ni en la consola).
    expect(seen.filter((s) => s.includes(wrong))).toEqual([])
    expect(await app.getByRole('tab').count()).toBe(0)
    expect(stack.token).not.toBe(wrong)
  })

  test('30 paneles en una pestaña siguen siendo usables', async ({ stack, app }) => {
    const first = await stack.newTab('muchos', ECHO_SCRIPT)
    const panes = [first.paneId]
    // Una columna de 5 filas y, en cada fila, 5 divisiones a la derecha: 30 paneles en total.
    for (let r = 1; r < 5; r++) {
      const p = await stack.json<{ paneId: string }>([
        'split',
        first.paneId,
        '--down',
        '--',
        process.execPath,
        '-e',
        ECHO_SCRIPT,
      ])
      panes.push(p.paneId)
    }
    for (const row of [...panes]) {
      for (let c = 0; c < 5; c++) {
        const p = await stack.json<{ paneId: string }>([
          'split',
          row,
          '--right',
          '--',
          process.execPath,
          '-e',
          ECHO_SCRIPT,
        ])
        panes.push(p.paneId)
      }
    }
    expect(panes).toHaveLength(30)

    await app.goto(stack.url())
    await expect(app.locator('section.pane')).toHaveCount(30, { timeout: 30_000 })
    for (const id of panes)
      await expect
        .poll(async () => (await bufferText(app, id)) ?? '', { timeout: 30_000 })
        .toContain('LISTO')

    // Todos tienen tamaño útil (encabezado y terminal a la vista), nada se sale de la ventana.
    const boxes = await app.locator('section.pane').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect()
        return { w: r.width, h: r.height, right: r.right, bottom: r.bottom }
      }),
    )
    for (const b of boxes) {
      expect(b.w).toBeGreaterThan(40)
      expect(b.h).toBeGreaterThan(40)
      expect(b.right).toBeLessThanOrEqual(1281)
      expect(b.bottom).toBeLessThanOrEqual(801)
    }

    // La interfaz responde: escribir en un panel concreto llega a su proceso y no a los demás.
    const target = panes[17] as string
    await app.locator(`[data-pane-id="${target}"] .xterm`).click()
    await app.keyboard.insertText('treinta-paneles-777')
    await app.keyboard.press('Enter')
    await expect
      .poll(async () => (await stack.nexo(['read', target, '--lines', '50'])).stdout)
      .toContain('treinta-paneles-777')
    expect((await stack.nexo(['read', panes[3] as string, '--lines', '50'])).stdout).not.toContain(
      'treinta-paneles-777',
    )
  })
})
