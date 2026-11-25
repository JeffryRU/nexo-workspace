import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { App, type AppProps } from './App.tsx'
import { createAppModel } from './app/model.tsx'
import { detectSource } from './daemon/info.ts'
import { createDaemonSession } from './daemon/session.ts'
import { createXtermHandle } from './terminal/xterm-adapter.ts'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
const root = document.getElementById('root')
if (root === null) throw new Error('falta el elemento #root')

const source = detectSource(window)
const [app, setApp] = createSignal<AppProps | undefined>()

async function load(): Promise<void> {
  const result = await source.getDaemonInfo()
  if (!result.ok) {
    setApp({ kind: 'no-daemon', reason: result.reason, onRetry: () => void load() })
    return
  }
  const session = createDaemonSession({
    info: result.info,
    source,
    queryClient,
    // El renderer DOM de xterm repinta todas las filas en cada desplazamiento, también con el panel oculto
    // (y midiendo sin layout), lo que satura el hilo principal: una terminal oculta no recibe salida hasta
    // que se muestra (el hub acota lo pendiente).
    hiddenBudget: 0,
  })
  setApp({ kind: 'ready', model: createAppModel(session, createXtermHandle) })
  await session.start()
}

void load()

render(
  () => (
    <QueryClientProvider client={queryClient}>
      <App state={app()} />
    </QueryClientProvider>
  ),
  root,
)
