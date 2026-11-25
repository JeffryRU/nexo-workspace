import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { ECHO_SCRIPT, expect, type Stack, test } from './stack.ts'

declare global {
  var __pwned: unknown
}

/** Abre la interfaz con una pestaña de agente nueva (botón de la barra) y espera su redactor. */
async function openAgentTab(stack: Stack, app: Page): Promise<void> {
  await stack.newTab('base', ECHO_SCRIPT)
  await app.goto(stack.url())
  await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
  await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
  await expect(app.locator('.agent-panel')).toBeVisible()
  // Los chips salen de `agent.providers` (proveedor falso del daemon).
  await expect(app.getByLabel('Proveedor')).toBeVisible()
}

const composer = (app: Page) => app.getByLabel('Mensaje para el agente')

async function say(app: Page, text: string): Promise<void> {
  await composer(app).fill(text)
  await composer(app).press('Enter')
}

test.describe('panel de agente', () => {
  test('conversación: el primer mensaje crea la sesión y la respuesta llega por deltas', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'hola agente')
    await expect(app.locator('.bubble')).toHaveText('hola agente')
    await expect(app.locator('.blk-text')).toContainText('Eco: hola agente')
    // Terminado el turno: sin botón de interrumpir, con el uso del turno y el redactor libre.
    await expect(app.locator('.usage')).toBeVisible()
    await expect(app.getByRole('button', { name: 'Interrumpir' })).toHaveCount(0)
    // Los chips pasan a ser de solo lectura al existir la sesión.
    await expect(app.locator('select.chip')).toHaveCount(0)
    await expect(app.locator('.chip.fixed').first()).toHaveText('fake')

    // Segundo turno, y el documento sobrevive a recargar la página (se vuelve a abrir la sesión).
    await say(app, 'otra vez')
    await expect(app.locator('.blk-text')).toHaveCount(2)
    await app.reload()
    await expect(app.locator('.bubble')).toHaveCount(2)
    await expect(app.locator('.blk-text').last()).toContainText('Eco: otra vez')
  })

  test('el Markdown de la respuesta se pinta y el HTML hostil no se ejecuta', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    const md = [
      'Resumen',
      '## Título',
      'Hay **negrita**, `código` y un [enlace](https://example.com).',
      '<img src=x onerror="globalThis.__pwned=1"> [malo](javascript:globalThis.__pwned=2)',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n')
    await say(app, md)
    const answer = app.locator('.blk-text')
    await expect(answer.locator('strong')).toHaveText('negrita')
    await expect(answer.locator('table')).toBeVisible()
    await expect(answer.locator('a[href="https://example.com/"]')).toBeVisible()
    await expect(answer.locator('img, script, a[href^="javascript"]')).toHaveCount(0)
    expect(await app.evaluate(() => globalThis.__pwned)).toBeUndefined()
  })

  test('permiso: se responde con el teclado y la acción termina', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'permiso')
    const perm = app.locator('section.perm.pending')
    await expect(perm).toBeVisible()
    await expect(perm.locator('.perm-option')).toHaveCount(2)
    await expect(app.locator('.agent-banner.pending')).toContainText('1 pendiente')
    await expect(composer(app)).toBeEnabled()
    // El atajo de navegación lleva el foco al permiso; «1» elige Permitir.
    await composer(app).press('Alt+Shift+ArrowDown')
    await expect(perm.locator('.perm-option').first()).toBeFocused()
    await app.keyboard.press('1')
    await expect(app.locator('.perm-result')).toContainText('Permitido')
    await expect(app.locator('.blk-text').last()).toContainText('Permiso concedido')
    await expect(app.locator('.blk-action .status-icon')).toHaveAttribute('aria-label', 'Correcta')
    await app.locator('.blk-action .fold-head').click()
    await expect(app.locator('.blk-action .fold-body')).toContainText('a.txt')
  })

  test('permiso rechazado con el ratón', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'permiso')
    await app.getByRole('button', { name: /Rechazar/ }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Permiso rechazado')
    await expect(app.locator('.perm-result')).toContainText('Rechazado')
  })

  test('pregunta: se elige una opción y se responde', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'pregunta')
    const form = app.locator('form.ask.pending')
    await expect(form).toBeVisible()
    await expect(form.getByRole('button', { name: 'Responder' })).toBeDisabled()
    await form.getByLabel('B', { exact: true }).check()
    await form.getByRole('button', { name: 'Responder' }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Elegiste: B')
    await expect(app.locator('form.ask[data-state="answered"]')).toBeVisible()
  })

  test('interrupción: el botón corta un turno que no termina', async ({ stack, app }) => {
    await openAgentTab(stack, app)
    await say(app, 'largo')
    const stop = app.getByRole('button', { name: 'Interrumpir' })
    await expect(stop).toBeVisible()
    await expect(app.locator('.blk-text')).toContainText('pensando')
    await stop.click()
    await expect(stop).toHaveCount(0)
    await expect(app.locator('.usage')).toContainText('Interrumpido')
    // Tras interrumpir se puede seguir conversando.
    await say(app, 'ya')
    await expect(app.locator('.blk-text').last()).toContainText('Eco: ya')
  })

  test('un documento largo en streaming: solo se dibuja una ventana y se sigue el final', async ({
    stack,
    app,
  }) => {
    await openAgentTab(stack, app)
    await say(app, 'lento 400')
    await expect(app.locator('.usage')).toBeVisible({ timeout: 60_000 })
    await expect(app.locator('.blk-text')).toContainText('palabra palabra')
  })

  test('el atajo Alt+Mayús+A abre una pestaña de agente', async ({ stack, app }) => {
    await stack.newTab('base', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    await app.locator('.xterm').first().click()
    await app.keyboard.press('Alt+Shift+A')
    await expect(app.locator('.agent-panel')).toBeVisible()
    await expect(app.getByRole('tab')).toHaveCount(2)
  })
})

// Capturas de la documentación: `NEXO_CAPTURAS=1 pnpm e2e -g capturas` las regenera en docs/capturas.
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'capturas')

test.describe('capturas', () => {
  test.skip(process.env.NEXO_CAPTURAS === undefined, 'solo con NEXO_CAPTURAS=1')
  const shot = async (app: Page, name: string) => {
    // La carpeta real es la del entorno donde corre la prueba: se sustituye por una neutra en la captura.
    await app.evaluate(() => {
      for (const el of document.querySelectorAll('.chip.fixed.ellipsis'))
        el.textContent = '~/proyecto'
      for (const el of document.querySelectorAll<HTMLInputElement>('.chip-cwd')) {
        el.placeholder = '~/proyecto'
      }
    })
    mkdirSync(OUT, { recursive: true })
    await app.screenshot({ path: join(OUT, `f2-5-${name}.png`) })
  }

  test('capturas del panel de agente', async ({ stack, app }) => {
    await app.setViewportSize({ width: 1280, height: 800 })
    await openAgentTab(stack, app)
    await shot(app, 'inicio-chips')

    await say(
      app,
      [
        'Resumen del cambio',
        '## Qué se hizo',
        '- Se añadió el **panel de agente** con `AgentDocument`',
        '- Markdown seguro: `<script>` y [javascript:](javascript:alert(1)) no hacen nada',
        '',
        '```ts',
        'const total = bloques.length // solo se dibujan los visibles',
        '```',
        '',
        '| Bloque | Estado |',
        '|---|---|',
        '| user | listo |',
        '| action | plegable |',
      ].join('\n'),
    )
    await expect(app.locator('.usage')).toBeVisible()
    await shot(app, 'conversacion')

    await say(app, 'permiso')
    await expect(app.locator('section.perm.pending')).toBeVisible()
    await shot(app, 'permiso')
    await app.getByRole('button', { name: /Permitir/ }).click()
    await expect(app.locator('.blk-text').last()).toContainText('Permiso concedido')
    await app.locator('.blk-action .fold-head').click()
    await shot(app, 'accion')

    await say(app, 'pregunta')
    await expect(app.locator('form.ask.pending')).toBeVisible()
    await shot(app, 'pregunta')
  })
})
