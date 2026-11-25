import {
  type ClientOptions,
  type ClientState,
  NexoClient,
  type Snapshot,
  webSocketTransport,
} from '@nexo/client'
import {
  type EventData,
  type EventName,
  type MethodName,
  type MethodParams,
  type MethodResult,
  TerminalId,
} from '@nexo/contracts'
import type { QueryClient } from '@tanstack/solid-query'
import { createSignal } from 'solid-js'
import { createActions } from '../state/actions.ts'
import { STORE_EVENTS, type StoreEvent, type StoreEventName } from '../state/model.ts'
import { createAppStore } from '../state/store.ts'
import { createUiState } from '../state/ui.ts'
import { TerminalHub } from '../terminal/hub.ts'
import type { DaemonInfo } from './info.ts'

/** Lo que la interfaz necesita de `NexoClient` (permite un cliente falso en pruebas). */
export type ClientLike = Pick<NexoClient, 'call' | 'on' | 'subscribe' | 'connect' | 'close'> & {
  readonly state: ClientState
}

export type SessionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline'

export type SessionDeps = {
  info: DaemonInfo
  makeClient?: (options: ClientOptions) => ClientLike
  frame?: (cb: () => void) => void
  /** Si se da, el snapshot inicial pasa por la caché de solid-query. */
  queryClient?: QueryClient
  /** Caracteres por fotograma que recibe una terminal oculta (0: ninguno hasta que se muestre). */
  hiddenBudget?: number
}

const READ_CHUNK_BYTES = 256 * 1024

const defaultFrame = (cb: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => cb())
  else setTimeout(cb, 16)
}

/**
 * Conecta con el daemon y alimenta el store y el hub. Al reconectar (o perder eventos) el cliente pide un
 * `snapshot` (autoResync): se reconstruye el estado y cada terminal relee desde su último offset.
 */
export function createDaemonSession(deps: SessionDeps) {
  const store = createAppStore()
  const ui = createUiState()
  const [status, setStatus] = createSignal<SessionStatus>('connecting')
  const [failure, setFailure] = createSignal<string | undefined>()
  let client: ClientLike | undefined
  let generation = 0

  const hub = new TerminalHub({
    frame: deps.frame ?? defaultFrame,
    ...(deps.hiddenBudget === undefined ? {} : { hiddenBudget: deps.hiddenBudget }),
    read: async (terminalId, fromOffset) => {
      const c = client
      if (c === undefined) throw new Error('sin cliente')
      // Lecturas de 256 KiB: una de 1 MiB (el máximo) son tareas largas en la página al validar y trocear.
      return c.call('terminal.read', {
        terminalId: TerminalId.parse(terminalId),
        fromOffset,
        maxBytes: READ_CHUNK_BYTES,
      })
    },
  })

  const actions = createActions({
    client: () => (status() === 'open' ? client : undefined),
    store,
    ui,
  })

  const syncTerminals = () => hub.sync(store.terminalIds())

  const onSnapshot = (snapshot: Snapshot) => {
    store.applySnapshot(snapshot)
    syncTerminals()
    void hub.resync()
  }

  function makeClient(options: ClientOptions): ClientLike {
    return (deps.makeClient ?? ((o) => new NexoClient(o)))(options)
  }

  async function start(): Promise<void> {
    const mine = ++generation
    client?.close()
    setStatus('connecting')
    setFailure(undefined)
    const c = makeClient({
      transport: () =>
        webSocketTransport({ url: `ws://127.0.0.1:${deps.info.port}`, token: deps.info.token }),
      autoResync: true,
      onSnapshot,
    })
    client = c

    c.on('state', (s) => {
      if (mine !== generation) return
      if (s === 'open') setStatus('open')
      else if (s === 'reconnecting') setStatus('reconnecting')
      else if (s === 'closed') {
        setStatus('offline')
        setFailure('closed')
      }
    })
    for (const name of STORE_EVENTS) {
      c.on(
        name as EventName,
        ((data: unknown, seq: number) => {
          if (mine !== generation) return
          store.applyEvent({ event: name, seq, data } as StoreEvent)
          if (name === 'layout.changed' || name === 'workspace.changed') syncTerminals()
        }) as never,
      )
    }
    // La relectura de terminales no espera al `snapshot` (que puede tardar o perderse en plena ráfaga): se
    // dispara en cuanto el cliente avisa de que hay que ponerse al día.
    c.on('resync', () => {
      if (mine === generation) void hub.resync()
    })
    c.on('terminal.output', (data: EventData<'terminal.output'>) => {
      if (mine === generation) hub.onOutput(data.terminalId, data.offset, data.data)
    })

    try {
      await c.connect()
      if (mine !== generation) return
      await c.subscribe()
      const snapshot = await (deps.queryClient?.fetchQuery({
        queryKey: ['snapshot', mine],
        queryFn: () => c.call('snapshot', {}),
        staleTime: 0,
        gcTime: 0,
      }) ?? c.call('snapshot', {}))
      if (mine !== generation) return
      onSnapshot(snapshot)
      setStatus('open')
    } catch {
      if (mine !== generation) return
      c.close()
      setStatus('offline')
      setFailure('unreachable')
    }
  }

  return {
    store,
    ui,
    hub,
    actions,
    status,
    failure,
    start,
    /** Llamada al daemon con el cliente actual (para consultas de solid-query). */
    request<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
      if (client === undefined) return Promise.reject(new Error('sin conexión'))
      return client.call(method, params)
    },
    retry: start,
    dispose(): void {
      generation++
      client?.close()
      hub.dispose()
    },
  }
}

export type DaemonSession = ReturnType<typeof createDaemonSession>
export type { StoreEventName }
