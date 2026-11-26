import { FakeMemoryStore, FakeSummarizer } from '../fake-memory.ts'
import { runMemoryStoreConformance } from './memory-store.ts'
import { runSummarizerConformance } from './summarizer.ts'

runMemoryStoreConformance('FakeMemoryStore', () => ({
  store: new FakeMemoryStore({ maxBytes: 64 * 1024 }),
  maxBytes: 64 * 1024,
}))

runSummarizerConformance('FakeSummarizer (texto)', () => ({ summarizer: new FakeSummarizer() }))
runSummarizerConformance('FakeSummarizer (estructurado)', () => ({
  summarizer: new FakeSummarizer('fake-json', { structured: true }),
}))
