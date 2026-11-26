import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { CDPSession, Page } from '@playwright/test'
import {
  multiProviderEnv,
  STREAMING_PROVIDERS,
  startAgentTab,
  streamingOllama,
} from './providers.ts'
import { bufferText, ECHO_SCRIPT, expect, Stack, test } from './stack.ts'

// Presupuesto del contrato (docs/ARCHITECTURE.md, "Rendimiento"): cambiar de pestaña con 10 terminales
// activas tarda < 16 ms. En CI se acepta más margen por la variabilidad de los runners compartidos.
const TAB_SWITCH_P95_MS = Number(process.env.NEXO_PERF_TAB_P95_MS ?? '16')
// Salida masiva: ninguna tarea larga de la página (> 50 ms según la API) puede pasar de este límite.
const LONGTASK_MAX_MS = Number(process.env.NEXO_PERF_LONGTASK_MAX_MS ?? '150')
const HEAP_GROWTH_MAX_MB = Number(process.env.NEXO_PERF_HEAP_GROWTH_MB ?? '100')

// Tras una ráfaga de 20 MB, el xterm muestra la última línea a los pocos segundos de que el daemon la vea.
const LAST_LINE_MAX_MS = Number(process.env.NEXO_PERF_LAST_LINE_MS ?? '10000')

const TABS = 10
const SWITCHES = 50
const OUT_DIR = join(import.meta.dirname, 'results')

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] as number
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const r = (n: number) => Math.round(n * 100) / 100
  return {
    n: sorted.length,
    p50: r(percentile(sorted, 50)),
    p95: r(percentile(sorted, 95)),
    max: r(sorted[sorted.length - 1] ?? Number.NaN),
  }
}

function save(name: string, data: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`)
}

/** Salida continua: una línea de ~70 caracteres cada `EMIT_MS` ms. */
// En CI (2 núcleos compartidos con el daemon, 10 procesos y el navegador) se baja a una línea cada 20 ms: el
// ruido por CPU saturada tapaba la medida (p95 entre 12 y 44 ms con el mismo código).
const EMIT_MS = Number(process.env.NEXO_PERF_EMIT_MS ?? '5')
const EMITTER = `let n=0;setInterval(()=>console.log('linea '+(n++)+' '+'x'.repeat(60)),${EMIT_MS})`

test('cambiar de pestaña con 10 terminales activas: p95 < 16 ms', async ({ stack, app }) => {
  for (let i = 1; i <= TABS; i++) await stack.newTab(`t${i}`, EMITTER)
  await app.goto(stack.url())
  const tabs = app.getByRole('tab')
  await expect(tabs).toHaveCount(TABS)

  // Visita cada pestaña una vez: las terminales se crean al verlas por primera vez.
  for (let i = 0; i < TABS; i++) {
    await tabs.nth(i).click()
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true')
    await sleep(150)
  }
  await app.evaluate(() => {
    globalThis.__NEXO_PERF__ = undefined
  })

  for (let i = 0; i < SWITCHES; i++) {
    await tabs.nth((i + 1) % TABS).click()
    await app.waitForFunction((n) => (globalThis.__NEXO_PERF__?.tabSwitch.length ?? 0) >= n, i + 1)
    await sleep(40)
  }

  const samples = await app.evaluate(() => globalThis.__NEXO_PERF__)
  const work = summarize(samples?.tabSwitch ?? [])
  const raw = summarize(samples?.tabSwitchRaw ?? [])
  const result = {
    tabs: TABS,
    switches: SWITCHES,
    emitMs: EMIT_MS,
    limitP95Ms: TAB_SWITCH_P95_MS,
    work,
    raw,
  }
  save('tab-switch', result)
  console.log(`tab-switch (ms): ${JSON.stringify(result)}`)

  expect(work.n).toBeGreaterThanOrEqual(SWITCHES)
  expect(work.p95).toBeLessThan(TAB_SWITCH_P95_MS)
})

// F3.4: cinco proveedores de agente distintos (el de prueba, Ollama, Codex, Gemini y Antigravity, todos falsos) en
// pestañas distintas, emitiendo a la vez durante toda la medida. El umbral es el mismo que el de las terminales.
const AGENT_CHUNKS = Number(process.env.NEXO_PERF_AGENT_CHUNKS ?? '1500')
const AGENT_EMIT_MS = Number(process.env.NEXO_PERF_AGENT_EMIT_MS ?? '15')

test('cambiar de pestaña con 5 agentes de proveedores distintos emitiendo a la vez: p95 < 16 ms', async ({
  app,
}) => {
  const ollama = await streamingOllama(AGENT_CHUNKS, AGENT_EMIT_MS)
  const stack = await Stack.start(
    multiProviderEnv(ollama.url, { chunks: AGENT_CHUNKS, everyMs: AGENT_EMIT_MS }),
  )
  try {
    await stack.newTab('base', ECHO_SCRIPT)
    await app.goto(stack.url())
    await expect(app.getByRole('tab', { name: 'base' })).toBeVisible()
    for (const p of STREAMING_PROVIDERS) await startAgentTab(app, p.id, p.prompt(AGENT_CHUNKS))
    const tabs = app.getByRole('tab')
    const count = 1 + STREAMING_PROVIDERS.length
    await expect(tabs).toHaveCount(count)
    // Todos están emitiendo: cada panel ya tiene texto de su proveedor.
    for (let i = 1; i < count; i++) {
      await tabs.nth(i).click()
      await expect(app.locator('.agent-panel:visible .blk-text').last()).toContainText('palabra')
    }
    await app.evaluate(() => {
      globalThis.__NEXO_PERF__ = undefined
    })

    for (let i = 0; i < SWITCHES; i++) {
      await tabs.nth((i + 1) % count).click()
      await app.waitForFunction(
        (n) => (globalThis.__NEXO_PERF__?.tabSwitch.length ?? 0) >= n,
        i + 1,
      )
      await sleep(40)
    }
    // Seguían emitiendo mientras se medía: el panel a la vista no había terminado.
    await expect(app.locator('.agent-panel:visible .usage')).toHaveCount(0)

    const samples = await app.evaluate(() => globalThis.__NEXO_PERF__)
    const work = summarize(samples?.tabSwitch ?? [])
    const raw = summarize(samples?.tabSwitchRaw ?? [])
    const result = {
      providers: STREAMING_PROVIDERS.map((p) => p.id),
      switches: SWITCHES,
      emitMs: AGENT_EMIT_MS,
      limitP95Ms: TAB_SWITCH_P95_MS,
      work,
      raw,
    }
    save('tab-switch-agents', result)
    console.log(`tab-switch-agents (ms): ${JSON.stringify(result)}`)
    expect(work.n).toBeGreaterThanOrEqual(SWITCHES)
    expect(work.p95).toBeLessThan(TAB_SWITCH_P95_MS)
  } finally {
    await stack.dispose()
    await ollama.close()
  }
})

async function heapMb(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
  return Math.round((used / 1024 / 1024) * 10) / 10
}

async function longTasks(page: Page): Promise<number[]> {
  return page.evaluate(() => (globalThis as unknown as { __long: number[] }).__long ?? [])
}

// 20 MiB en líneas de 1 KiB cada vez que recibe una línea (así la página ya está mirando el panel).
const SPEW =
  "let n=0;let busy=false;process.stdin.on('data',()=>{if(busy)return;busy=true;const line='x'.repeat(1022)+'\\n';let i=0;(function w(){while(i<20480){i++;if(!process.stdout.write(i%1000===0?'tramo '+i+' '+line:line))return process.stdout.once('drain',w)}console.log('FIN-20MB-'+(++n));busy=false})()})"

test('una terminal que escupe 20 MB no congela la interfaz ni deja crecer la memoria', async ({
  stack,
  app,
}) => {
  const { paneId } = await stack.newTab('spew', SPEW)
  await app.addInitScript(() => {
    const w = globalThis as unknown as { __long: number[] }
    w.__long = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(e.duration)
    }).observe({ type: 'longtask', buffered: true })
    // Diagnóstico: qué scripts hay en los fotogramas largos (Long Animation Frames).
    const frames: unknown[] = []
    ;(w as unknown as { __loaf: unknown[] }).__loaf = frames
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as {
          duration: number
          scripts: { invoker: string; sourceFunctionName: string; duration: number }[]
        }[]) {
          frames.push({
            ms: Math.round(e.duration),
            scripts: e.scripts.map(
              (x) => `${x.invoker}/${x.sourceFunctionName}:${Math.round(x.duration)}`,
            ),
          })
        }
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch {
      // sin soporte de Long Animation Frames
    }
  })
  await app.goto(stack.url())
  await expect(app.getByRole('tab')).toHaveCount(1)
  await expect.poll(() => bufferText(app, paneId), { timeout: 20_000 }).not.toBeNull()
  const cdp = await app.context().newCDPSession(app)
  await cdp.send('Performance.enable')
  // Para reproducir una máquina lenta en local: NEXO_PERF_CPU_THROTTLE=10 (también conviene subir los umbrales).
  if (process.env.NEXO_PERF_CPU_THROTTLE !== undefined) {
    await cdp.send('Emulation.setCPUThrottlingRate', {
      rate: Number(process.env.NEXO_PERF_CPU_THROTTLE),
    })
  }

  const baselineMb = await heapMb(cdp)
  await sleep(500) // la pausa del GC forzado también cuenta como tarea larga: que no caiga en la ronda
  const rounds: {
    heapAfterMb: number
    peakMb: number
    longestTaskMs: number
    seconds: number
    lastLineMs: number
  }[] = []
  for (let round = 1; round <= 2; round++) {
    const before = (await longTasks(app)).length
    let peak = 0
    const t0 = Date.now()
    await stack.nexo(['send', paneId, '--enter', 'go'])
    for (;;) {
      // El fin se comprueba en el daemon: la interfaz puede ir por detrás (ver docs/ARCHITECTURE.md, Rendimiento).
      const tail = (await stack.nexo(['read', paneId, '--lines', '2'])).stdout
      if (tail.includes(`FIN-20MB-${round}`)) break
      if (Date.now() - t0 > 120_000) throw new Error('la salida de 20 MB no terminó a tiempo')
      const { metrics } = await cdp.send('Performance.getMetrics')
      const used = metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0
      peak = Math.max(peak, used / 1048576)
      await sleep(250)
    }
    // La última línea debe verse en el xterm (no solo en el daemon) en poco tiempo (issue #21).
    const tDaemon = Date.now()
    await expect
      .poll(async () => (await bufferText(app, paneId))?.includes(`FIN-20MB-${round}`) ?? false, {
        timeout: LAST_LINE_MAX_MS + 5000,
        intervals: [100],
      })
      .toBe(true)
    const lastLineMs = Date.now() - tDaemon
    await sleep(2000) // la interfaz sigue procesando lo recibido
    const seconds = Math.round((Date.now() - t0) / 100) / 10
    const during = (await longTasks(app)).slice(before)
    const heapAfterMb = await heapMb(cdp)
    await sleep(500)
    rounds.push({
      heapAfterMb,
      peakMb: Math.round(peak * 10) / 10,
      longestTaskMs: Math.round(Math.max(0, ...during)),
      seconds,
      lastLineMs,
    })
  }
  const result = {
    limitLongTaskMs: LONGTASK_MAX_MS,
    limitLastLineMs: LAST_LINE_MAX_MS,
    limitHeapGrowthMb: HEAP_GROWTH_MAX_MB,
    baselineMb,
    rounds,
  }
  const slowFrames = await app.evaluate(() =>
    ((globalThis as unknown as { __loaf: { ms: number }[] }).__loaf ?? []).filter(
      (f) => f.ms >= 80,
    ),
  )
  save('output-20mb', { ...result, slowFrames })
  console.log(`fotogramas largos: ${JSON.stringify(slowFrames)}`)
  console.log(`salida de 20 MB: ${JSON.stringify(result)}`)

  for (const r of rounds) expect(r.longestTaskMs).toBeLessThan(LONGTASK_MAX_MS)
  for (const r of rounds) expect(r.lastLineMs).toBeLessThan(LAST_LINE_MAX_MS)
  // Tras la salida la memoria no puede haber crecido sin límite (el scrollback de xterm está acotado)...
  expect(rounds[1]?.heapAfterMb ?? Number.POSITIVE_INFINITY).toBeLessThan(
    baselineMb + HEAP_GROWTH_MAX_MB,
  )
  // ...y una segunda tanda de 20 MB no suma sobre la primera.
  expect((rounds[1]?.heapAfterMb ?? 0) - (rounds[0]?.heapAfterMb ?? 0)).toBeLessThan(
    HEAP_GROWTH_MAX_MB / 2,
  )
})

// --- Agente (F2.6) -----------------------------------------------------------------------------------------

// Del Enter al primer texto de la respuesta en pantalla (el proveedor falso emite el primer trozo a los ~20 ms,
// el resto es RPC del daemon, eventos por el WebSocket y el fotograma que lo pinta).
const FIRST_DELTA_MAX_MS = Number(process.env.NEXO_PERF_FIRST_DELTA_MS ?? '500')
// Desplazamiento de un documento de 5 000 bloques: p95 del intervalo entre fotogramas durante el recorrido.
const SCROLL_FRAME_P95_MS = Number(process.env.NEXO_PERF_SCROLL_FRAME_P95_MS ?? '50')

// Velocidad del recorrido continuo: unos 2 500 px/s (una pantalla de 800 px cada 0,3 s).
const SCROLL_SPEED_PX_S = 2500

type AgentPerfWindow = {
  __fd?: { t0: number; pending: boolean; count: number; samples: number[] }
}

const visiblePanel = (app: Page) => app.locator('.tab-panel:not([hidden])')
const composerOf = (app: Page) => visiblePanel(app).getByLabel('Mensaje para el agente')

/** Abre una pestaña de agente nueva (la sesión existe tras el primer mensaje) y espera a poder escribir. */
async function openAgent(app: Page): Promise<void> {
  const before = await app.getByRole('tab').count()
  await app.getByRole('button', { name: 'Nueva pestaña de agente' }).click()
  await expect(app.getByRole('tab')).toHaveCount(before + 1)
  await expect(visiblePanel(app).getByLabel('Proveedor')).toBeVisible()
}

async function say(app: Page, text: string): Promise<void> {
  await composerOf(app).fill(text)
  await composerOf(app).press('Enter')
}

test('latencia del primer delta del agente en pantalla desde el envío', async ({ stack, app }) => {
  await stack.newTab('base', EMITTER)
  await app.goto(stack.url())
  await expect(app.getByRole('tab')).toHaveCount(1)
  await openAgent(app)
  // El primer mensaje abre la sesión (agent.create): se mide aparte, no entra en el umbral.
  const tFirst = Date.now()
  await say(app, 'hola')
  await expect(visiblePanel(app).locator('.usage')).toHaveCount(1)
  const firstSendMs = Date.now() - tFirst

  await app.evaluate(() => {
    const w = globalThis as unknown as AgentPerfWindow
    w.__fd = { t0: 0, pending: false, count: 0, samples: [] }
    const fd = w.__fd
    window.addEventListener(
      'keydown',
      (e) => {
        const el = e.target as HTMLElement | null
        if (e.key === 'Enter' && el?.getAttribute('aria-label') === 'Mensaje para el agente') {
          fd.t0 = performance.now()
          fd.count = document.querySelectorAll('.tab-panel:not([hidden]) .blk-text').length
          fd.pending = true
        }
      },
      true,
    )
    new MutationObserver(() => {
      if (!fd.pending) return
      const blocks = document.querySelectorAll('.tab-panel:not([hidden]) .blk-text')
      const last = blocks[blocks.length - 1]
      if (blocks.length > fd.count && (last?.textContent ?? '').trim().length > 0) {
        fd.samples.push(performance.now() - fd.t0)
        fd.pending = false
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true })
  })

  const TURNS = 10
  for (let i = 1; i <= TURNS; i++) {
    await say(app, 'lento 3')
    await app.waitForFunction(
      (n) => ((globalThis as unknown as AgentPerfWindow).__fd?.samples.length ?? 0) >= n,
      i,
    )
    await expect(visiblePanel(app).locator('.usage')).toHaveCount(i + 1)
  }
  const samples = await app.evaluate(() => (globalThis as unknown as AgentPerfWindow).__fd?.samples)
  const stats = summarize(samples ?? [])
  const result = {
    turns: TURNS,
    limitP95Ms: FIRST_DELTA_MAX_MS,
    firstSendWithSessionMs: firstSendMs,
    ...stats,
  }
  save('agent-first-delta', result)
  console.log(`primer delta (ms): ${JSON.stringify(result)}`)
  expect(stats.n).toBe(TURNS)
  expect(stats.p95).toBeLessThan(FIRST_DELTA_MAX_MS)
})

test('desplazamiento fluido en un documento de 5 000 bloques', async ({ stack, app }) => {
  await stack.newTab('base', EMITTER)
  await app.goto(stack.url())
  await expect(app.getByRole('tab')).toHaveCount(1)
  await openAgent(app)
  // 1 bloque del usuario + 4 998 de texto + 1 de uso al terminar el turno = 5 000.
  await say(app, 'bloques 4998')
  await expect(visiblePanel(app).locator('.usage')).toHaveCount(1, { timeout: 120_000 })
  await expect(visiblePanel(app).locator('.vitem').first()).toHaveAttribute('aria-setsize', '5000')

  const run = await app.evaluate(
    async ({ speed, seconds }) => {
      const feed = document.querySelector<HTMLElement>('.tab-panel:not([hidden]) [role="feed"]')
      if (feed === null) throw new Error('sin documento')
      const longs: number[] = []
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) longs.push(e.duration)
      }).observe({ type: 'longtask' })
      const total = feed.scrollHeight - feed.clientHeight
      let maxNodes = 0
      const sample = () => {
        maxNodes = Math.max(maxNodes, feed.querySelectorAll('.vitem').length)
      }
      // 1) Recorrido continuo a velocidad constante (un gesto de arrastre rápido) desde la mitad del documento.
      const start = Math.round(total / 2)
      feed.scrollTop = start
      await new Promise((r) => setTimeout(r, 500))
      const frames: number[] = []
      await new Promise<void>((resolve) => {
        const t0 = performance.now()
        let last = t0
        const step = (now: number) => {
          frames.push(now - last)
          last = now
          const elapsed = (now - t0) / 1000
          feed.scrollTop = start + speed * elapsed
          sample()
          if (elapsed < seconds) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
      // 2) Saltos largos a posiciones repartidas por todo el documento (arrastrar la barra de desplazamiento).
      for (let i = 1; i <= 20; i++) {
        feed.scrollTop = (((i * 7919) % 1000) / 1000) * total
        await new Promise((r) => setTimeout(r, 120))
        sample()
      }
      await new Promise((r) => setTimeout(r, 300))
      return { frames, longs, maxNodes, total }
    },
    { speed: SCROLL_SPEED_PX_S, seconds: 5 },
  )
  const frames = summarize(run.frames.slice(1))
  const longest = Math.round(Math.max(0, ...run.longs))
  const result = {
    blocks: 5000,
    documentPx: Math.round(run.total),
    speedPxPerS: SCROLL_SPEED_PX_S,
    limitFrameP95Ms: SCROLL_FRAME_P95_MS,
    limitLongTaskMs: LONGTASK_MAX_MS,
    frames,
    longTasks: run.longs.length,
    longestTaskMs: longest,
    maxNodes: run.maxNodes,
  }
  save('agent-scroll-5000', result)
  console.log(`desplazamiento 5 000 bloques: ${JSON.stringify(result)}`)
  // Solo se dibuja una ventana, no los 5 000 bloques.
  expect(run.maxNodes).toBeLessThan(200)
  expect(longest).toBeLessThan(LONGTASK_MAX_MS)
  expect(frames.p95).toBeLessThan(SCROLL_FRAME_P95_MS)
})

test('cambiar de pestaña con agentes activos emitiendo: p95 < 16 ms', async ({ stack, app }) => {
  test.setTimeout(420_000)
  const AGENTS = 4
  const TERMINALS = 2
  for (let i = 1; i <= TERMINALS; i++) await stack.newTab(`t${i}`, EMITTER)
  await app.goto(stack.url())
  await expect(app.getByRole('tab')).toHaveCount(TERMINALS)
  for (let i = 0; i < AGENTS; i++) {
    await openAgent(app)
    // Una conversación larga y continua: unos 50 trozos por segundo durante minutos, mientras se cambia de pestaña.
    await say(app, process.env.NEXO_PERF_AGENT_MESSAGE ?? 'charla 1000')
    await expect(visiblePanel(app).locator('.blk-text').first()).toContainText(/palabra|Eco/)
  }
  const tabs = app.getByRole('tab')
  const total = TERMINALS + AGENTS
  await expect(tabs).toHaveCount(total)

  for (let i = 0; i < total; i++) {
    await tabs.nth(i).click()
    await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true')
    await sleep(150)
  }
  await app.evaluate(() => {
    globalThis.__NEXO_PERF__ = undefined
  })
  for (let i = 0; i < SWITCHES; i++) {
    await tabs.nth((i + 1) % total).click()
    await app.waitForFunction((n) => (globalThis.__NEXO_PERF__?.tabSwitch.length ?? 0) >= n, i + 1)
    await sleep(40)
  }
  const samples = await app.evaluate(() => globalThis.__NEXO_PERF__)
  const work = summarize(samples?.tabSwitch ?? [])
  const raw = summarize(samples?.tabSwitchRaw ?? [])
  const result = {
    terminals: TERMINALS,
    agents: AGENTS,
    switches: SWITCHES,
    limitP95Ms: TAB_SWITCH_P95_MS,
    work,
    raw,
  }
  save('tab-switch-agents', result)
  console.log(`tab-switch con agentes (ms): ${JSON.stringify(result)}`)
  expect(work.n).toBeGreaterThanOrEqual(SWITCHES)
  expect(work.p95).toBeLessThan(TAB_SWITCH_P95_MS)
})
