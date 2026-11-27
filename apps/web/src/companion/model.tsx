import { companionApi } from '@nexo/client'
import type { CompanionState, CompanionStateView } from '@nexo/contracts'
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  useContext,
} from 'solid-js'
import type { AppModel } from '../app/model.tsx'
import { es } from '../i18n/es.ts'
import { CompanionAssetCache, type LoadedCompanion } from './cache.ts'
import { type DrawableAsset, mergeState, resolveAsset, sanitizeView } from './view.ts'

/** Lo que se dibuja ahora: la imagen del estado (o la de `idle`), ya con su URL de objeto. */
export type CompanionShown = {
  id: string
  name: string
  /** El estado que el daemon pide. */
  state: CompanionState
  /** El estado cuya imagen se dibuja (`idle` si la del estado falló o falta). */
  drawnState: CompanionState
  asset: DrawableAsset
}

const REVISE_MS = 15_000

/**
 * Modelo de la mascota (F5.3). Una sola instancia por ventana (la crea `Workbench`):
 * - sigue `companion.state` (consulta al conectar + evento; descarta lo viejo, repetido o fuera de orden);
 * - carga los recursos del compañero elegido por el caché (por id) y los entrega como URL de objeto;
 * - cuando cambia el compañero, **lo anterior deja de dibujarse al instante** y una carga que termina tarde
 *   se ignora (generación), así nunca se ve la imagen de la mascota anterior;
 * - ante un recurso roto usa `idle`; si no queda nada que dibujar, no muestra nada.
 */
export function createCompanionModel(app: AppModel, injected?: CompanionAssetCache) {
  const [view, setView] = createSignal<CompanionStateView | undefined>()
  const [loaded, setLoaded] = createSignal<LoadedCompanion | undefined>()
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [broken, setBroken] = createSignal<ReadonlySet<CompanionState>>(new Set())
  const [reload, setReload] = createSignal(0)
  // Cada llamada usa el cliente de ese momento (tras reconectar puede ser otro).
  const api = () => {
    const client = app.agentClient()
    if (client === undefined) throw new Error(es.status.offline)
    return companionApi(client)
  }
  const cache =
    injected ??
    new CompanionAssetCache({ get: (p, o) => api().get(p, o), asset: (p, o) => api().asset(p, o) })
  let generation = 0
  let gotEvent = false

  // Conexión: estado inicial por consulta y cambios por evento. Al reconectar se parte de cero (el paquete pudo cambiar).
  createEffect(
    on(
      () => (app.status() === 'open' ? app.agentClient() : undefined),
      (client) => {
        if (client === undefined) return
        const events = companionApi(client)
        gotEvent = false
        cache.disposeAll()
        setLoaded(undefined)
        setReload((n) => n + 1)
        const off = events.onState((raw) => {
          const next = sanitizeView(raw)
          if (next === undefined) return
          gotEvent = true
          setView((cur) => mergeState(cur, next))
          // Un evento posterior a una carga fallida es la ocasión de reintentar.
          if (loadFailed()) setReload((n) => n + 1)
        })
        let live = true
        void events
          .state({ timeoutMs: REVISE_MS })
          .then((raw) => {
            const next = sanitizeView(raw)
            if (live && next !== undefined && !gotEvent) setView(next)
          })
          .catch(() => {})
        onCleanup(() => {
          live = false
          off()
        })
      },
    ),
  )

  const selectedId = createMemo(() => view()?.selected ?? null)

  // Recursos del compañero elegido.
  createEffect(
    on([selectedId, reload], ([id]) => {
      const mine = ++generation
      setBroken(new Set<CompanionState>())
      setLoadFailed(false)
      const client = app.status() === 'open' ? app.agentClient() : undefined
      if (id === null || client === undefined) {
        cache.setCurrent(null)
        setLoaded(undefined)
        return
      }
      const c = cache
      c.setCurrent(id)
      // Lo que se tenía era de otro compañero: fuera ya. Si el nuevo está en caché, se dibuja de inmediato.
      setLoaded(c.peek(id))
      c.load(id)
        .then((l) => {
          if (mine !== generation) return
          setLoaded(l)
        })
        .catch(() => {
          if (mine !== generation) return
          c.forget(id)
          setLoaded(undefined)
          setLoadFailed(true)
        })
    }),
  )

  onCleanup(() => {
    generation++
    cache.disposeAll()
  })

  const shown = createMemo((): CompanionShown | undefined => {
    const v = view()
    const l = loaded()
    if (v === undefined || l === undefined || v.selected !== l.id) return undefined
    if (app.settings.companionHidden()) return undefined
    const r = resolveAsset(l.assets, v.state, broken())
    if (r === undefined) return undefined
    return { id: l.id, name: l.manifest.name, state: v.state, drawnState: r.state, asset: r.asset }
  })

  return {
    view,
    selected: selectedId,
    loaded,
    loadFailed,
    shown,
    hidden: app.settings.companionHidden,
    setHidden: (value: boolean) => app.settings.setCompanionHidden(value),
    /** El navegador no pudo decodificar la imagen de este estado: se usa `idle`. */
    markBroken(state: CompanionState): void {
      setBroken((cur) => new Set(cur).add(state))
    },
    /** Elige compañero (`null` = sin mascota). Lanza si el daemon lo rechaza. */
    async select(id: string | null): Promise<void> {
      const r = await api().select({ id }, { timeoutMs: REVISE_MS })
      // La respuesta llega antes o después del evento; ambos dicen lo mismo.
      setView((cur) =>
        cur === undefined
          ? { state: 'idle', since: Date.now(), selected: r.selected }
          : cur.selected === r.selected
            ? cur
            : { ...cur, selected: r.selected },
      )
    },
    cache,
    /** Vuelve a cargar el compañero elegido (cambió en disco). */
    reload(): void {
      const id = selectedId()
      if (id !== null) cache.forget(id)
      setReload((n) => n + 1)
    },
    /** Revoca todo lo cargado (al desmontar ya lo hace solo). */
    dispose(): void {
      generation++
      cache.disposeAll()
    },
  }
}

export type CompanionModel = ReturnType<typeof createCompanionModel>

const Context = createContext<CompanionModel>()
export const CompanionProvider = Context.Provider

export function useCompanion(): CompanionModel {
  const m = useContext(Context)
  if (m === undefined) throw new Error('falta el proveedor de la mascota')
  return m
}
