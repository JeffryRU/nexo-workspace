import type { PermissionMode, ProviderInfo } from '@nexo/contracts'
import { createMemo, For, Show } from 'solid-js'
import { es, format } from '../i18n/es.ts'
import type { AgentPaneModel } from './pane-model.ts'

export type ProvidersState = {
  loading: boolean
  error: string | undefined
  providers: readonly ProviderInfo[]
  retry: () => void
}

/** Nombre legible de un esfuerzo; los que no conocemos se muestran tal cual. */
const effortName = (value: string): string =>
  (es.agent.effortNames as Readonly<Record<string, string>>)[value] ?? value

/** Aviso de un proveedor no disponible: el motivo ya suele nombrarlo, así que no se repite el nombre. */
export function unavailableNote(p: Pick<ProviderInfo, 'name' | 'reason'>): string {
  if (p.reason === undefined) return `${p.name}: ${es.agent.providerUnavailableNoReason}`
  return p.reason.toLowerCase().includes(p.name.toLowerCase()) ? p.reason : `${p.name}: ${p.reason}`
}

/** Alto del redactor en líneas: crece con el texto hasta un tope. */
export function composerRows(text: string, max = 8): number {
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++
  return Math.min(max, lines)
}

/** Enter envía; Shift+Enter (y la composición de un IME) no. */
export function isSubmitKey(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing
}

export function Composer(props: {
  model: AgentPaneModel
  providers: ProvidersState
  defaultCwd: string | undefined
}) {
  const m = props.model
  let area!: HTMLTextAreaElement

  const all = () => props.providers.providers
  const available = () => all().filter((p) => p.available)
  const unavailable = () => all().filter((p) => !p.available)
  const provider = createMemo(() => {
    const chosen = m.provider.get()
    return available().find((p) => p.id === chosen) ?? available()[0]
  })
  const caps = () => provider()?.capabilities
  const modelId = () => m.modelChoice.get() ?? caps()?.defaultModel ?? ''
  const efforts = () => {
    const info = caps()?.models.find((x) => x.id === modelId())
    return info?.efforts ?? caps()?.efforts ?? []
  }
  const mode = (): PermissionMode | undefined => {
    const modes = caps()?.permissionModes ?? []
    const chosen = m.permissionMode.get()
    if (chosen !== undefined && modes.includes(chosen)) return chosen
    return modes.includes('ask') ? 'ask' : modes[0]
  }

  const hasSession = () => m.sessionId !== undefined
  const session = m.session
  // Los chips de una sesión muestran los nombres que da el proveedor, no los ids crudos.
  const sessionProvider = () => all().find((p) => p.id === session()?.provider)
  const sessionModelLabel = (id: string) =>
    sessionProvider()?.capabilities.models.find((x) => x.id === id)?.label ?? id
  const dead = () => m.removed() || m.status() === 'error' || m.docState() === 'failed'
  const working = () => m.status() === 'working'
  const waiting = () => m.status() === 'needs-input'
  const canType = () => !dead()
  const readyToSend = () => {
    if (m.busy() || dead() || m.draft().trim() === '') return false
    if (hasSession()) return m.canSend
    return provider() !== undefined
  }

  const submit = async () => {
    if (!readyToSend()) return
    const text = m.draft().trim()
    let ok: boolean
    if (hasSession()) ok = await m.send(text)
    else {
      const p = provider()
      if (p === undefined) return
      ok = await m.create(
        {
          provider: p.id,
          model: modelId() === '' ? undefined : modelId(),
          effort: m.effort.get(),
          permissionMode: mode(),
          cwd: m.cwd.get().trim() === '' ? props.defaultCwd : m.cwd.get().trim(),
        },
        text,
      )
    }
    if (ok) m.setDraft('')
    area.focus()
  }

  const placeholder = () => {
    if (m.removed()) return es.agent.placeholderClosed
    if (m.status() === 'error' || m.docState() === 'failed') return es.agent.placeholderError
    if (working() || waiting()) return es.agent.placeholderBusy
    return es.agent.placeholder
  }

  const select = (
    label: string,
    value: () => string,
    options: () => { value: string; label: string; disabled?: boolean; title?: string }[],
    onChange: (v: string) => void,
  ) => (
    <select
      class="chip"
      aria-label={label}
      title={label}
      value={value()}
      onChange={(e) => onChange(e.currentTarget.value)}
    >
      <For each={options()}>
        {(o) => (
          <option value={o.value} disabled={o.disabled} title={o.title}>
            {o.label}
          </option>
        )}
      </For>
    </select>
  )

  return (
    <form
      class="composer"
      aria-label={es.agent.composer}
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <fieldset class="chips">
        <legend class="sr-only">{es.agent.options}</legend>
        <Show
          when={!hasSession()}
          fallback={
            <>
              <span class="chip fixed" title={es.agent.chipProvider}>
                {sessionProvider()?.name ?? session()?.provider ?? ''}
              </span>
              <Show when={session()?.model}>
                {(x) => (
                  <span class="chip fixed" title={es.agent.chipModel}>
                    {sessionModelLabel(x())}
                  </span>
                )}
              </Show>
              <Show when={session()?.effort}>
                {(x) => (
                  <span class="chip fixed" title={es.agent.chipEffort}>
                    {effortName(x())}
                  </span>
                )}
              </Show>
              <span class="chip fixed" title={es.agent.chipPermissions}>
                {es.agent.permissionMode[session()?.permissionMode ?? 'ask']}
              </span>
              <span class="chip fixed ellipsis" title={session()?.cwd}>
                {session()?.cwd}
              </span>
            </>
          }
        >
          <Show
            when={!props.providers.loading}
            fallback={
              <span class="chip loading" role="status" aria-busy="true">
                {es.agent.loadingProviders}
              </span>
            }
          >
            <Show
              when={props.providers.error === undefined}
              fallback={
                <span class="chip error" role="alert">
                  {es.agent.providersError}{' '}
                  <button type="button" class="text-button" onClick={props.providers.retry}>
                    {es.status.retry}
                  </button>
                </span>
              }
            >
              <Show when={all().length > 0}>
                {select(
                  es.agent.chipProvider,
                  () => provider()?.id ?? '',
                  () => [
                    ...(provider() === undefined
                      ? [{ value: '', label: '—', disabled: true }]
                      : []),
                    ...all().map((p) => ({
                      value: p.id,
                      label: p.available
                        ? p.name
                        : format(es.agent.providerUnavailable, { name: p.name }),
                      disabled: !p.available,
                      ...(p.available || p.reason === undefined ? {} : { title: p.reason }),
                    })),
                  ],
                  (v) => {
                    m.provider.set(v)
                    m.modelChoice.set(undefined)
                    m.effort.set(undefined)
                    m.permissionMode.set(undefined)
                  },
                )}
              </Show>
              <For each={unavailable()}>
                {(p) => (
                  <span class="chip error" role="note" title={p.reason}>
                    {unavailableNote(p)}
                  </span>
                )}
              </For>
              <Show when={provider() === undefined}>
                <span class="chip error">{es.agent.noProviders}</span>
              </Show>
              <Show when={provider()}>
                <Show when={(caps()?.models.length ?? 0) > 0}>
                  {select(
                    es.agent.chipModel,
                    modelId,
                    () => [
                      ...(modelId() === '' ? [{ value: '', label: es.agent.defaultOption }] : []),
                      ...(caps()?.models ?? []).map((x) => ({
                        value: x.id,
                        label: x.label ?? x.id,
                      })),
                    ],
                    (v) => {
                      m.modelChoice.set(v)
                      m.effort.set(undefined)
                    },
                  )}
                </Show>
                <Show when={efforts().length > 0}>
                  {select(
                    es.agent.chipEffort,
                    () => m.effort.get() ?? '',
                    () => [
                      { value: '', label: es.agent.defaultEffort },
                      ...efforts().map((x) => ({ value: x, label: effortName(x) })),
                    ],
                    (v) => m.effort.set(v === '' ? undefined : v),
                  )}
                </Show>
                {select(
                  es.agent.chipPermissions,
                  () => mode() ?? '',
                  () =>
                    (caps()?.permissionModes ?? []).map((x) => ({
                      value: x,
                      label: es.agent.permissionMode[x],
                    })),
                  (v) => m.permissionMode.set(v as PermissionMode),
                )}
                <input
                  type="text"
                  class="chip chip-cwd"
                  aria-label={es.agent.chipCwd}
                  title={es.agent.chipCwd}
                  placeholder={props.defaultCwd ?? es.agent.cwdPlaceholder}
                  value={m.cwd.get()}
                  maxLength={1024}
                  onInput={(e) => m.cwd.set(e.currentTarget.value)}
                />
              </Show>
            </Show>
          </Show>
        </Show>
      </fieldset>
      <div class="composer-row">
        <textarea
          ref={area}
          class="composer-input"
          rows={composerRows(m.draft())}
          value={m.draft()}
          disabled={!canType()}
          aria-label={es.agent.message}
          placeholder={placeholder()}
          maxLength={100_000}
          onInput={(e) => m.setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (isSubmitKey(e)) {
              e.preventDefault()
              void submit()
            } else if (e.key === 'Escape' && (working() || waiting())) {
              e.preventDefault()
              void m.interrupt()
            }
          }}
        />
        <Show when={working() || waiting()}>
          <button
            type="button"
            class="interrupt"
            title={es.agent.interrupt}
            aria-label={es.agent.interrupt}
            onClick={() => void m.interrupt()}
          >
            ■
          </button>
        </Show>
        <button
          type="submit"
          class="send"
          title={es.agent.send}
          aria-label={es.agent.send}
          disabled={!readyToSend()}
        >
          ↑
        </button>
      </div>
    </form>
  )
}
