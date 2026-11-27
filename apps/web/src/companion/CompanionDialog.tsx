import { companionApi } from '@nexo/client'
import { useQuery } from '@tanstack/solid-query'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { useModel } from '../app/model.tsx'
import { es, format } from '../i18n/es.ts'
import { useCompanion } from './model.tsx'
import './companion.css'

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Botón de la barra de estado que abre el selector de mascota. */
export function CompanionToggle() {
  const app = useModel()
  return (
    <button
      type="button"
      class="status-toggle companion-toggle"
      title={es.companion.openHint}
      aria-haspopup="dialog"
      onClick={() => app.ui.setCompanionOpen(true)}
    >
      {es.companion.open}
    </button>
  )
}

/**
 * Selector de mascota: «Sin mascota» es la primera opción (y la de por omisión), luego los paquetes válidos del
 * daemon, y un interruptor para ocultar el dibujo en esta ventana. Los nombres, autores, descripciones y motivos
 * vienen de paquetes ajenos: se pintan como texto plano.
 */
export function CompanionDialog() {
  const app = useModel()
  const companion = useCompanion()
  let dialog!: HTMLDivElement
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<string | undefined>()

  createEffect(() => {
    if (app.ui.companionOpen()) dialog?.focus()
    else setFailure(undefined)
  })

  const list = useQuery(() => ({
    queryKey: ['companion', 'list'],
    queryFn: async () => {
      const client = app.agentClient()
      if (client === undefined) throw new Error(es.status.offline)
      const r = await companionApi(client).list({ timeoutMs: 15_000 })
      // Un paquete que cambió de versión en disco se vuelve a cargar.
      if (companion.cache.invalidateStale(r.companions).includes(companion.selected() ?? '')) {
        companion.reload()
      }
      return r
    },
    enabled: app.status() === 'open' && app.ui.companionOpen(),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  }))

  const choose = async (id: string | null) => {
    if (pending() || id === companion.selected()) return
    setPending(true)
    setFailure(undefined)
    try {
      await companion.select(id)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setPending(false)
    }
  }
  const close = () => app.ui.setCompanionOpen(false)

  return (
    <Show when={app.ui.companionOpen()}>
      <div class="modal-backdrop">
        <div
          ref={dialog}
          class="modal companion-dialog"
          role="dialog"
          aria-modal="true"
          aria-label={es.companion.title}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close()
          }}
        >
          <header class="companion-head">
            <h2>{es.companion.title}</h2>
            <button type="button" class="text-button" onClick={close}>
              {es.companion.close}
            </button>
          </header>

          <Show when={list.isPending}>
            <p class="muted" role="status">
              {es.companion.loading}
            </p>
          </Show>
          <Show when={list.isError}>
            <p class="companion-error" role="alert">
              {format(es.companion.loadFailed, { message: errorText(list.error) })}{' '}
              <button type="button" class="text-button" onClick={() => void list.refetch()}>
                {es.companion.retry}
              </button>
            </p>
          </Show>

          <fieldset class="companion-choices" aria-busy={pending()}>
            <legend>{es.companion.choose}</legend>
            <label class="companion-choice" data-companion="none">
              <input
                type="radio"
                name="companion"
                checked={companion.selected() === null}
                onChange={() => void choose(null)}
              />
              <span class="companion-choice-main">
                <span class="companion-choice-name">{es.companion.none}</span>
                <span class="muted">{es.companion.noneHint}</span>
              </span>
            </label>
            <For each={list.data?.companions ?? []}>
              {(c) => (
                <label class="companion-choice" data-companion={c.id}>
                  <input
                    type="radio"
                    name="companion"
                    checked={companion.selected() === c.id}
                    onChange={() => void choose(c.id)}
                  />
                  <span class="companion-choice-main">
                    <span class="companion-choice-name">
                      {c.name} <span class="muted">v{c.version}</span>
                    </span>
                    <span class="muted">
                      {format(es.companion.by, { author: c.author })} · {c.license}
                    </span>
                    <Show when={c.description}>{(d) => <span class="muted">{d()}</span>}</Show>
                  </span>
                </label>
              )}
            </For>
          </fieldset>

          <Show when={list.data && list.data.companions.length === 0}>
            <p class="muted" role="status">
              {es.companion.empty}
            </p>
          </Show>
          <Show when={(list.data?.invalid.length ?? 0) > 0}>
            <section class="companion-invalid" aria-label={es.companion.invalidTitle}>
              <h3>{es.companion.invalidTitle}</h3>
              <ul>
                <For each={list.data?.invalid ?? []}>
                  {(i) => (
                    <li class="muted">
                      {format(es.companion.invalid, { id: i.id, reason: i.reason })}
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={failure()}>
            {(f) => (
              <p class="companion-error" role="alert">
                {format(es.companion.selectFailed, { message: f() })}
              </p>
            )}
          </Show>
          <Show when={companion.loadFailed()}>
            <p class="companion-error" role="status">
              {es.companion.imagesFailed}
            </p>
          </Show>

          <label class="companion-show">
            <input
              type="checkbox"
              checked={!companion.hidden()}
              onChange={(e) => companion.setHidden(!e.currentTarget.checked)}
            />
            <span>{es.companion.show}</span>
          </label>
          <p class="muted companion-hint">{es.companion.showHint}</p>
        </div>
      </div>
    </Show>
  )
}
