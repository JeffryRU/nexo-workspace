import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { assertMemoryBlock, type MemoryDelivery, type MemoryInjectionPort } from '@nexo/core'

/**
 * Claude Code (Agent SDK): el bloque va al final del prompt de sistema (`systemPrompt.append` sobre el preset
 * `claude_code`), y un hook `SessionStart` con origen `compact` lo vuelve a poner como `additionalContext` cuando
 * Claude Code compacta su contexto (ADR 0007).
 */
export class ClaudeMemoryInjection implements MemoryInjectionPort {
  readonly providerId = 'claude'
  readonly delivery: MemoryDelivery = 'system-prompt'
  readonly onCompact = 'reinject' as const

  prepare(block: string): string {
    assertMemoryBlock(block)
    return block
  }
}

/** Opciones del SDK que entregan la memoria: el prompt de sistema ampliado y el hook de reinyección. */
export function claudeMemoryOptions(memory: string): Pick<Options, 'systemPrompt' | 'hooks'> {
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: memory },
    hooks: {
      SessionStart: [
        {
          matcher: 'compact',
          hooks: [
            async (input) =>
              input.hook_event_name === 'SessionStart' && input.source === 'compact'
                ? {
                    hookSpecificOutput: {
                      hookEventName: 'SessionStart',
                      additionalContext: memory,
                    },
                  }
                : {},
          ],
        },
      ],
    },
  }
}
