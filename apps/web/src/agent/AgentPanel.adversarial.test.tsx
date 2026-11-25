import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { bid, blocks, mountAgent, settle } from './test-helpers.ts'

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    i % 3 === 0
      ? blocks.user(i, `pregunta ${i}`)
      : i % 3 === 1
        ? blocks.text(i, `respuesta **${i}** con \`código\``)
        : blocks.action(i, { title: `acción ${i}`, output: `salida ${i}` }),
  )

describe('panel de agente: documentos enormes y hostiles', () => {
  it('5 000 bloques: solo se dibuja una ventana pequeña del documento', async () => {
    const t = performance.now()
    const h = await mountAgent({ blocks: many(5000) })
    expect(h.model.ids()).toHaveLength(5000)
    const drawn = h.container.querySelectorAll('[data-block-id]').length
    expect(drawn).toBeGreaterThan(0)
    expect(drawn).toBeLessThan(120)
    expect(h.container.querySelector('[role="feed"] article')?.getAttribute('aria-setsize')).toBe(
      '5000',
    )
    // Montar y sincronizar 5 000 bloques cabe de sobra en unos segundos incluso en una máquina lenta.
    expect(performance.now() - t).toBeLessThan(15_000)
  })

  it('5 000 bloques + una ráfaga de 3 000 deltas: un fotograma, el texto completo, DOM acotado', async () => {
    const h = await mountAgent({
      blocks: [...many(4999), blocks.text(4999, '', { complete: false })],
    })
    const before = h.frames.pending
    const t = performance.now()
    for (let i = 1; i <= 3000; i++) h.emitDelta(bid(4999), i, `t${i} `)
    expect(h.frames.pending - before).toBeLessThanOrEqual(1)
    await h.flush()
    expect(performance.now() - t).toBeLessThan(10_000)
    const sig = h.model.block(bid(4999))
    expect((sig() as { text: string }).text.endsWith('t3000 ')).toBe(true)
    expect(h.container.querySelectorAll('[data-block-id]').length).toBeLessThan(120)
  })

  it('llegan 500 bloques nuevos de golpe sin repintar todo el documento', async () => {
    const h = await mountAgent({ blocks: many(100) })
    const first = h.container.querySelector('[data-block-id]')
    for (let i = 100; i < 600; i++) h.emitBlock(blocks.text(i, `n${i}`))
    await h.flush()
    expect(h.model.ids()).toHaveLength(600)
    expect(h.container.querySelector('[data-block-id]')).toBe(first)
  })

  it('un bloque truncado y uno con texto vacío se pintan sin romper el documento', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.text(0, '', { complete: false }),
        blocks.text(1, 'x'.repeat(130_000), { truncated: true }),
        blocks.action(2, { truncated: true, output: 'cortado…', status: 'running' }),
      ],
    })
    expect(h.container.querySelectorAll('.notice').length).toBeGreaterThanOrEqual(1)
    expect(h.container.querySelectorAll('[data-block-id]')).toHaveLength(3)
  })

  it('Markdown hostil dentro de un mensaje del agente no ejecuta nada', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.text(
          0,
          '<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![p](https://evil.example/p.png)\n\n<script>alert(1)</script>',
        ),
        blocks.reasoning(1, '<script>alert(2)</script>'),
      ],
    })
    fireEvent.click(h.container.querySelector('.reasoning .fold-head') as HTMLElement)
    expect(h.container.querySelector('script, img, iframe')).toBeNull()
    expect(h.container.querySelector('a[href^="javascript"]')).toBeNull()
    expect(h.container.innerHTML).not.toContain('evil.example')
  })

  it('ANSI hostil en la salida de una acción: sin escapes ni elementos', async () => {
    const ESC = String.fromCharCode(27)
    const BEL = String.fromCharCode(7)
    const h = await mountAgent({
      blocks: [
        blocks.action(0, {
          output: `${ESC}]0;titulo${BEL}${ESC}[2J${ESC}[31m<img src=x onerror=1>${ESC}[0m${ESC}]8;;javascript:alert(1)${BEL}clic${ESC}]8;;${BEL}\u0000`,
        }),
      ],
    })
    fireEvent.click(h.container.querySelector('.fold-head') as HTMLElement)
    const out = h.container.querySelector('.fold-body pre.output') as HTMLElement
    expect(out.textContent).toBe('<img src=x onerror=1>clic')
    expect(out.querySelector('img, a')).toBeNull()
    expect(h.container.innerHTML).not.toContain(ESC)
  })

  it('un diff enorme se recorta a las líneas que caben', async () => {
    const patch = `@@ -1 +1 @@\n${Array.from({ length: 6000 }, (_, i) => `+linea ${i}`).join('\n')}`
    const h = await mountAgent({
      blocks: [blocks.action(0, { kind: 'edit', diff: { path: 'a', patch } })],
    })
    fireEvent.click(h.container.querySelector('.fold-head') as HTMLElement)
    expect(h.container.querySelectorAll('.diff-line').length).toBeLessThanOrEqual(2000)
    expect(h.container.querySelector('.diff .notice')?.textContent).toContain('ocultas')
  })

  it('una salida de 100 000 líneas solo pinta la cola', async () => {
    const output = Array.from({ length: 100_000 }, (_, i) => `l${i}`).join('\n')
    const h = await mountAgent({ blocks: [blocks.action(0, { output })] })
    fireEvent.click(h.container.querySelector('.fold-head') as HTMLElement)
    const pre = h.container.querySelector('.fold-body pre.output:last-of-type') as HTMLElement
    expect(pre.textContent?.endsWith('l99999')).toBe(true)
    expect(pre.textContent?.split('\n').length).toBeLessThanOrEqual(1500)
  })

  it('títulos, herramientas y mensajes de error con HTML se muestran como texto', async () => {
    const evil = '<img src=x onerror=alert(1)>'
    const h = await mountAgent({
      blocks: [
        blocks.user(0, evil),
        blocks.action(1, { title: evil, tool: evil }),
        blocks.permission(2, { title: evil, tool: evil, detail: evil }),
        blocks.question(3, {
          questions: [
            {
              id: 'a',
              question: evil,
              header: evil,
              options: [{ label: evil }],
              multiSelect: false,
              allowText: false,
            },
          ],
        }),
        blocks.error(4, { message: evil, code: evil }),
        blocks.plan(5),
      ],
    })
    expect(h.container.querySelector('img')).toBeNull()
    expect(h.container.textContent).toContain(evil)
  })

  it('una respuesta doble a un permiso (CONFLICT) no deja el bloque bloqueado', async () => {
    const h = await mountAgent({
      blocks: [blocks.permission(0)],
      session: { status: 'needs-input' },
    })
    h.client.handlers.set('agent.respond', () => {
      throw new Error('CONFLICT: ya resuelto')
    })
    const first = h.container.querySelector('.perm-option') as HTMLButtonElement
    fireEvent.click(first)
    await settle()
    expect(h.appModel.ui.error()).toContain('CONFLICT')
    expect(first.disabled).toBe(false)
  })

  it('ráfaga de estados y bloques mientras se reabre la conexión no deja el panel inconsistente', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)] })
    for (let i = 0; i < 50; i++) {
      h.client.emit('resync', { reason: 'gap' })
      h.emitStatus(i % 2 === 0 ? 'working' : 'done')
    }
    await h.flush()
    await h.flush()
    expect(h.model.docState()).toBe('live')
    expect(h.model.ids()).toEqual([bid(0)])
  })
})
