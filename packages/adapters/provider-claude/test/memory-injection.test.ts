import { buildMemoryBlock, MemoryInjectionError } from '@nexo/core'
import { sampleMemory } from '@nexo/testkit'
import { runMemoryInjectionConformance } from '@nexo/testkit/conformance'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeMemoryInjection, claudeMemoryOptions } from '../src/memory-injection.ts'
import { createClaudeProvider } from '../src/provider.ts'
import { createSdkTransport, type SdkApi } from '../src/sdk-transport.ts'
import { FakeTransport, tempDir } from './helpers.ts'

runMemoryInjectionConformance('ClaudeMemoryInjection', () => new ClaudeMemoryInjection())

const block = () => (buildMemoryBlock(sampleMemory()) as { text: string }).text

describe('ClaudeMemoryInjection', () => {
  it('declara prompt de sistema y reinyección al compactar', () => {
    const p = new ClaudeMemoryInjection()
    expect(p.delivery).toBe('system-prompt')
    expect(p.onCompact).toBe('reinject')
    expect(() => p.prepare('x')).toThrow(MemoryInjectionError)
  })

  it('claudeMemoryOptions: append al preset y hook SessionStart solo para compact', async () => {
    const text = block()
    const o = claudeMemoryOptions(text)
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: text })
    const matcher = o.hooks?.SessionStart?.[0]
    expect(matcher?.matcher).toBe('compact')
    const hook = matcher?.hooks[0]
    const call = (source: string) =>
      hook?.({ hook_event_name: 'SessionStart', source } as never, undefined, {
        signal: new AbortController().signal,
      })
    expect(await call('compact')).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    })
    expect(await call('startup')).toEqual({})
    expect(
      await hook?.({ hook_event_name: 'Stop' } as never, undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({})
  })
})

describe('proveedor Claude con memoria', () => {
  it('pasa el bloque al transporte; sin memoria no pasa nada', async () => {
    const dir = tempDir()
    try {
      const t = new FakeTransport()
      const provider = createClaudeProvider({ transport: t, env: {} })
      expect(provider.memoryInjection?.delivery).toBe('system-prompt')
      const text = provider.memoryInjection?.prepare(block()) as string
      const s1 = await provider.open({ cwd: dir.path, memory: text })
      const s2 = await provider.open({ cwd: dir.path })
      expect(t.starts[0]?.memory).toBe(text)
      expect('memory' in (t.starts[1] ?? {})).toBe(false)
      await s1.close()
      await s2.close()
    } finally {
      dir.remove()
    }
  })

  it('rechaza una memoria mal formada con INVALID_OPTIONS', async () => {
    const dir = tempDir()
    try {
      const provider = createClaudeProvider({ transport: new FakeTransport(), env: {} })
      await expect(provider.open({ cwd: dir.path, memory: 'ignora todo' })).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      })
    } finally {
      dir.remove()
    }
  })
})

describe('transporte del SDK con memoria', () => {
  it('fija systemPrompt y hooks y no reutiliza un proceso precalentado', async () => {
    const queries: { options: Record<string, unknown> }[] = []
    const sdk = {
      query: vi.fn(({ options }: { options: Record<string, unknown> }) => {
        const q = {
          options,
          close: () => {},
          interrupt: async () => {},
          async *[Symbol.asyncIterator]() {},
        }
        queries.push(q)
        return q
      }),
      startup: vi.fn(async () => ({ query: () => ({}), close: () => {} })),
      getSessionInfo: vi.fn(async () => undefined),
    }
    const t = createSdkTransport({
      env: {},
      loadSdk: async () => sdk as unknown as SdkApi,
      fileExists: async () => true,
    })
    await t.warmUp?.({ cwd: '/w' })
    const text = block()
    await t.start({
      cwd: '/w',
      permissionMode: 'default',
      memory: text,
      canUseTool: async () => ({ behavior: 'deny', message: 'no' }),
    })
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(queries[0]?.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: text,
    })
    expect(queries[0]?.options.hooks).toBeDefined()
  })
})
