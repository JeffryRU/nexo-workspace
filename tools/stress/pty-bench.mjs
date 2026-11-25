// Coste del salto IPC del pty host frente al adaptador directo (issue #15).
//   node tools/stress/pty-bench.mjs [--echoes 300] [--mb 20] [--json]
// Mide (a) latencia de un eco ida y vuelta (write -> onData) y (b) throughput de salida (MB/s) con
// los dos adaptadores, en el mismo proceso y en el mismo orden.
const { NodePtyPort } = await import(
  new URL('../../packages/adapters/pty-node/src/index.ts', import.meta.url).href
)
const { PtyHostPort } = await import(
  new URL('../../packages/adapters/pty-host/src/index.ts', import.meta.url).href
)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const echoes = Number(arg('echoes', '300'))
const megabytes = Number(arg('mb', '20'))

const ECHO_SCRIPT =
  "process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.on('data', (d) => process.stdout.write('<' + d.toString() + '>')); console.log('listo')"
const FLOOD_SCRIPT = `const chunk = ('0123456789abcdef'.repeat(63) + '\\n'); let left = ${megabytes} * 1024 * 1024; function go() { while (left > 0) { left -= chunk.length; if (!process.stdout.write(chunk)) { process.stdout.once('drain', go); return } } process.stdout.write('FIN_DE_SALIDA\\n') } go()`

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

async function measure(name, port) {
  const spawn = (script) =>
    port.spawn({ cmd: process.execPath, args: ['-e', script], cols: 120, rows: 30 })

  // Eco
  const echo = await spawn(ECHO_SCRIPT)
  let buf = ''
  let waiter
  echo.onData((d) => {
    buf += d
    waiter?.()
  })
  const waitFor = (text) =>
    new Promise((resolve) => {
      const check = () => {
        const i = buf.indexOf(text)
        if (i === -1) return
        buf = buf.slice(i + text.length)
        waiter = undefined
        resolve()
      }
      waiter = check
      check()
    })
  await waitFor('listo')
  const times = []
  for (let i = 0; i < echoes; i++) {
    const t0 = performance.now()
    echo.write('a')
    await waitFor('<a>')
    times.push(performance.now() - t0)
  }
  echo.kill()
  times.sort((a, b) => a - b)

  // Throughput
  const flood = await spawn(FLOOD_SCRIPT)
  let received = 0
  const done = new Promise((resolve) => {
    let tail = ''
    flood.onData((d) => {
      received += d.length
      tail = (tail + d).slice(-40)
      if (tail.includes('FIN_DE_SALIDA')) resolve()
    })
  })
  const t0 = performance.now()
  await done
  const secs = (performance.now() - t0) / 1000
  flood.kill()

  return {
    adapter: name,
    echoMsP50: +percentile(times, 0.5).toFixed(2),
    echoMsP95: +percentile(times, 0.95).toFixed(2),
    echoMsMax: +times[times.length - 1].toFixed(2),
    outputMB: +(received / 1048576).toFixed(1),
    seconds: +secs.toFixed(2),
    mbPerSec: +(received / 1048576 / secs).toFixed(1),
  }
}

const results = []
const direct = new NodePtyPort()
results.push(await measure('direct', direct))
const host = new PtyHostPort()
results.push(await measure('host', host))
host.dispose()
console.table(results)
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2),
  )
}
setTimeout(() => process.exit(0), 500).unref()
process.exit(0)
