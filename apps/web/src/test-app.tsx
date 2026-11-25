import type { Snapshot } from '@nexo/client'
import { render } from '@solidjs/testing-library'
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query'
import { App } from './App.tsx'
import { createAppModel } from './app/model.tsx'
import { createDaemonSession } from './daemon/session.ts'
import { FakeClient, FakeXterm, manualFrames } from './test-helpers.ts'

export const info = { port: 4317, token: 'AbCdEfGhIjKlMnOpQrStUvWxYz012345' }

/** Monta la aplicación completa con cliente y xterm falsos. */
export async function mountApp(snapshot: Snapshot, client = new FakeClient()) {
  client.snapshot = snapshot
  const frames = manualFrames()
  const xterms = new Map<number, FakeXterm>()
  let n = 0
  const session = createDaemonSession({ info, makeClient: () => client, frame: frames.frame })
  const model = createAppModel(
    session,
    () => {
      const x = new FakeXterm()
      xterms.set(n++, x)
      return x
    },
    frames.frame,
  )
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(() => (
    <QueryClientProvider client={queryClient}>
      <App state={{ kind: 'ready', model }} />
    </QueryClientProvider>
  ))
  await session.start()
  return { ...view, session, model, client, frames, xterms }
}
