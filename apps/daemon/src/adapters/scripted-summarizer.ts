import {
  type AbortSignalLike,
  estimateTokens,
  type SummarizeRequest,
  type SummarizeResponse,
  SummarizerError,
  type SummarizerPort,
} from '@nexo/core'

/**
 * Resumidor de memoria determinista para pruebas de integración y E2E (`NEXO_MEMORY_SUMMARIZER=fake`). No
 * llama a ningún modelo: observa una observación por cada una de las tres primeras líneas de la transcripción
 * y reflexiona recortando cada observación. Existe en la app (y no en `testkit`) porque el daemon real,
 * lanzado como proceso, tiene que poder usarlo y producción no importa `testkit`.
 */
export class ScriptedSummarizer implements SummarizerPort {
  readonly id = 'fake'

  async isAvailable(): Promise<boolean> {
    return true
  }

  async summarize(
    request: SummarizeRequest,
    options?: { signal?: AbortSignalLike },
  ): Promise<SummarizeResponse> {
    if (options?.signal?.aborted) throw new SummarizerError('ABORTED', 'cancelado')
    if (request.kind === 'observe') {
      const lines = request.transcript.split('\n').filter((l) => l.trim() !== '')
      const text = lines
        .slice(0, 3)
        .map((l) => `- [media] [proyecto] Observado: ${l.slice(0, 120)}`)
        .join('\n')
      return {
        kind: 'observe',
        content: { format: 'text', text },
        usage: {
          model: 'fake',
          inputTokens: estimateTokens(request.transcript),
          outputTokens: estimateTokens(text),
          costUsd: 0,
        },
      }
    }
    const parts = [
      ...(request.reflection === null ? [] : [request.reflection.text.slice(0, 200)]),
      ...request.observations.map((o) => o.text.slice(0, 40)),
    ]
    const text = `- ${parts.join('; ').slice(0, 2000) || 'Sin novedades.'}`
    return {
      kind: 'reflect',
      text,
      usage: { model: 'fake', inputTokens: 100, outputTokens: estimateTokens(text), costUsd: 0 },
    }
  }
}
